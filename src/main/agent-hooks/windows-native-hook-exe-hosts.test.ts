// The real orca-agent-hook.exe must keep the .cmd hook's contract under every Windows hook runner (#20913).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { getManagedScript } from '../claude/hook-script'
import { CLAUDE_HOOK_SETTINGS, getManagedLifecycleHook } from '../claude/hook-settings'
import { getWindowsClaudeHookEntry } from '../claude/windows-hook-files'
import { WINDOWS_CMD_SAFE_PATH } from './installer-utils'
import {
  buildWindowsNativeHookExecutable,
  WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS
} from './windows-native-hook-exe.test-fixture'
import { findGitBash } from './windows-git-bash-path.test-fixture'
import { getWindowsPowerShellExecutablePath } from './windows-powershell-hook-launcher'

const PAYLOAD = JSON.stringify({
  session_id: 'native-hook-parity',
  hook_event_name: 'PreToolUse',
  tool_input: { command: 'echo "café 日本語 😀" & echo %PATH% | more ^ !x!' },
  transcript: 'y'.repeat(70_000)
})

type Post = { path: string; token: string | undefined; type: string | undefined; form: string }
type Listener = { server: Server; port: number; posts: Post[] }
type HookRun = { code: number | null; stdout: string; stderr: string; ms: number }

async function startListener(reply: 'now' | 'never' | number = 'now'): Promise<Listener> {
  const posts: Post[] = []
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      posts.push({
        path: req.url ?? '',
        token: req.headers['x-orca-agent-hook-token']?.toString(),
        type: req.headers['content-type'],
        form: JSON.stringify([...form.entries()])
      })
      if (reply === 'never') {
        return
      }
      setTimeout(() => res.writeHead(204).end(), reply === 'now' ? 0 : reply)
    })
  })
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  )
  return { server, port, posts }
}

function run(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  // `abandon` holds stdin open unwritten, the shape a caller outside an Orca pane produces.
  stdin: 'payload' | 'abandon' = 'payload'
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(program, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${program} did not exit with stdin ${stdin}`))
    }, 10_000)
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.stdin.on('error', () => {})
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, ms: Date.now() - started })
    })
    if (stdin === 'payload') {
      child.stdin.end(PAYLOAD)
    }
  })
}

function hookEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(ORCA_|CLAUDE_|GROK_|DEVIN_)/i.test(key) && key.toUpperCase() !== 'USERPROFILE'
    )
  )
  return { ...base, USERPROFILE: dir, ORCA_BACKGROUND_LAUNCH: '1', ...extra }
}

function paneEnv(listener: Listener, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return hookEnv({
    ORCA_AGENT_HOOK_PORT: String(listener.port),
    ORCA_AGENT_HOOK_TOKEN: 'native-token',
    ORCA_PANE_KEY: 'tab-1:leaf-1',
    ORCA_TAB_ID: 'tab-1',
    ORCA_AGENT_LAUNCH_TOKEN: 'launch-1',
    ORCA_WORKTREE_ID: 'repo::C:/src/repo',
    ORCA_AGENT_HOOK_ENV: 'production',
    ORCA_AGENT_HOOK_VERSION: '1',
    ...extra
  })
}

let dir = ''
let exePath = ''
let command = ''
const listeners: Server[] = []
const tempIsCmdSafe = WINDOWS_CMD_SAFE_PATH.test(join(tmpdir(), 'orca-native-hook-x', 'x.exe'))

describe.skipIf(process.platform !== 'win32' || !tempIsCmdSafe)('native agent hook hosts', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-native-hook-'))
    // A dev box's AutoRun target under the redirected profile; the .cmd parity leg starts cmd.exe.
    writeFileSync(join(dir, '.cmd_aliases.cmd'), '@echo off\r\n')
    exePath = join(dir, 'orca-agent-hook.exe')
    copyFileSync(buildWindowsNativeHookExecutable(), exePath)
    writeFileSync(join(dir, 'claude-hook.cmd'), getWindowsClaudeHookEntry())
    writeFileSync(join(dir, 'claude-hook-impl.cmd'), getManagedScript())
    command = getManagedLifecycleHook(
      join(dir, 'claude-hook.cmd'),
      CLAUDE_HOOK_SETTINGS,
      exePath
    ).command
  }, WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS)

  afterEach(() => {
    for (const server of listeners.splice(0)) {
      server.closeAllConnections()
      server.close()
    }
  })

  afterAll(() => removeTreeSync(dir))

  async function listen(reply?: 'now' | 'never' | number): Promise<Listener> {
    const listener = await startListener(reply)
    listeners.push(listener.server)
    return listener
  }

  it('registers a bare exe path and agent with nothing a shell would rewrite', () => {
    expect(command).toBe(`${exePath.replaceAll('\\', '/')} claude`)
  })

  it('answers {} and posts what the .cmd hook posts under Git Bash, PowerShell 5.1 and CreateProcess', async () => {
    const listener = await listen()
    const env = paneEnv(listener)
    const cmdRun = await run('cmd.exe', ['/d', '/c', join(dir, 'claude-hook.cmd')], env)
    expect(cmdRun.code).toBe(0)
    expect(listener.posts).toHaveLength(1)
    const reference = listener.posts[0]
    expect(reference.path).toBe('/hook/claude')

    const hosts: [string, string, string[]][] = [
      ['Git Bash -c', findGitBash(), ['-c', command]],
      [
        'PowerShell 5.1',
        getWindowsPowerShellExecutablePath(),
        ['-NoProfile', '-NonInteractive', '-Command', command]
      ],
      ['CreateProcess', exePath, ['claude']]
    ]
    for (const [name, program, args] of hosts) {
      const before = listener.posts.length
      const result = await run(program, args, env)
      expect(result.code, name).toBe(0)
      expect(result.stdout.trim(), name).toBe('{}')
      expect(result.stderr, name).toBe('')
      expect(listener.posts.slice(before), name).toEqual([reference])
    }
    expect(JSON.parse(reference.form)).toContainEqual(['payload', PAYLOAD])
    expect(reference.token).toBe('native-token')
    expect(reference.type).toBe('application/x-www-form-urlencoded')
  })

  it('exits 0 without reading stdin outside an Orca pane or in a background job (#11549, #9236)', async () => {
    const listener = await listen()
    for (const env of [
      hookEnv({}),
      paneEnv(listener, { ORCA_PANE_KEY: '' }),
      paneEnv(listener, { CLAUDE_JOB_DIR: join(dir, 'job') })
    ]) {
      const result = await run(exePath, ['claude'], env, 'abandon')
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe('{}')
    }
    expect(listener.posts).toHaveLength(0)
  })

  it('answers {} without reading stdin for a missing or unknown agent', async () => {
    const listener = await listen()
    for (const args of [[], ['codex'], ['Claude']]) {
      const result = await run(exePath, args, paneEnv(listener), 'abandon')
      expect(result.code, args.join(' ')).toBe(0)
      expect(result.stdout.trim(), args.join(' ')).toBe('{}')
    }
    expect(listener.posts).toHaveLength(0)
  })

  it('drains, but does not report, Claude hooks that Grok or Devin imported', async () => {
    const listener = await listen()
    for (const extra of [{ GROK_HOOK_EVENT: 'PreToolUse' }, { DEVIN_PROJECT_DIR: dir }]) {
      const result = await run(exePath, ['claude'], paneEnv(listener, extra))
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe('{}')
    }
    expect(listener.posts).toHaveLength(0)
  })

  it('re-reads the endpoint file for a listener that restarted after the pane', async () => {
    const listener = await listen()
    const endpoint = join(dir, 'endpoint.cmd')
    writeFileSync(
      endpoint,
      [
        `set ORCA_AGENT_HOOK_PORT=${listener.port}`,
        'set ORCA_AGENT_HOOK_TOKEN=fresh-token',
        'set ORCA_AGENT_HOOK_ENV=development',
        'set ORCA_AGENT_HOOK_VERSION=2',
        'set ORCA_AGENT_HOOK_TRANSPORT=raw-json-v1',
        ''
      ].join('\r\n')
    )
    const stale = paneEnv(listener, {
      ORCA_AGENT_HOOK_PORT: '1',
      ORCA_AGENT_HOOK_TOKEN: 'stale-token',
      ORCA_AGENT_HOOK_ENDPOINT: endpoint
    })
    expect((await run(exePath, ['claude'], stale)).code).toBe(0)
    expect(listener.posts).toHaveLength(1)
    expect(listener.posts[0].token).toBe('fresh-token')
    expect(JSON.parse(listener.posts[0].form)).toEqual(
      expect.arrayContaining([
        ['env', 'development'],
        ['version', '2']
      ])
    )
  })

  it('returns only after the listener answers, so the next event cannot overtake it', async () => {
    const listener = await listen(400)
    const result = await run(exePath, ['claude'], paneEnv(listener))
    expect(result.code).toBe(0)
    expect(result.ms).toBeGreaterThanOrEqual(400)
  })

  it('gives up on a listener that never answers at the 1.5 s cap, still exit 0', async () => {
    const listener = await listen('never')
    const result = await run(exePath, ['claude'], paneEnv(listener))
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('{}')
    expect(listener.posts).toHaveLength(1)
    expect(result.ms).toBeGreaterThanOrEqual(1400)
    expect(result.ms).toBeLessThan(5000)

    const refused = await run(exePath, ['claude'], paneEnv(listener, { ORCA_AGENT_HOOK_PORT: '1' }))
    expect(refused.code).toBe(0)
    expect(refused.stdout.trim()).toBe('{}')
  })
})
