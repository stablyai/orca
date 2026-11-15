import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTreeSync } from '../../../../shared/windows-transient-lock-removal'
import { WINDOWS_CMD_SAFE_PATH } from './windows-hook-command'
import {
  buildWindowsNativeHookExecutable,
  WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS
} from './testing/windows-native-hook-exe.test-fixture'

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
const listeners: Server[] = []
const tempIsCmdSafe = WINDOWS_CMD_SAFE_PATH.test(join(tmpdir(), 'orca-native-hook-x', 'x.exe'))

describe.skipIf(process.platform !== 'win32' || !tempIsCmdSafe)('native agent hook hosts', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-native-hook-'))
    exePath = join(dir, 'orca-agent-hook.exe')
    copyFileSync(buildWindowsNativeHookExecutable(), exePath)
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

  it('skips, without reading stdin, Claude hooks that Grok or Devin imported', async () => {
    const listener = await listen()
    for (const extra of [{ GROK_HOOK_EVENT: 'PreToolUse' }, { DEVIN_PROJECT_DIR: dir }]) {
      const result = await run(exePath, ['claude'], paneEnv(listener, extra), 'abandon')
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
})
