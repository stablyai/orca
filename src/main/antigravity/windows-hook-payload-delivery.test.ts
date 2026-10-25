import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: homedirMock.mockImplementation(actual.homedir)
  }
})

import { AntigravityHookService } from './hook-service'
import { ANTIGRAVITY_EVENTS, ANTIGRAVITY_PRE_TOOL_USE_DECISION } from './hook-events'
import { getManagedScript, getWindowsWrapperScript } from './hook-script'

// Literal ! characters expose inherited delayed-expansion corruption.
const PANE_KEY = 'tab-1:leaf-1!bang'
const WORKTREE_ID = 'repo-1::C:\\Users\\alice\\orca\\feature!branch'
const HOOK_TOKEN = 'antigravity-payload-delivery-token'
// Large UTF-8 payloads expose pipe chunking and code-page corruption.
const PAYLOAD = JSON.stringify({
  session_id: 'a3f9c1e0-antigravity-delivery',
  tool_name: 'Bash',
  tool_input: { command: 'echo "café 日本語 😀" & echo %PATH% | more' },
  transcript: 'y'.repeat(4096)
})

type HookPost = {
  payload: string | null
  paneKey: string | null
  worktreeId: string | null
  hookEventName: string | null
  token: string | null
  contentType: string | null
}

async function startHookListener(): Promise<{
  server: Server
  port: number
  posts: HookPost[]
}> {
  const posts: HookPost[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const form = new URLSearchParams(body)
      posts.push({
        payload: form.get('payload'),
        paneKey: form.get('paneKey'),
        worktreeId: form.get('worktreeId'),
        hookEventName: form.get('hook_event_name'),
        token: (req.headers['x-orca-agent-hook-token'] as string | undefined) ?? null,
        contentType: (req.headers['content-type'] as string | undefined) ?? null
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  return { server, port, posts }
}

type HookRun = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }

// Exercise inherited delayed expansion explicitly so the regression is reachable on every Windows host.
type DelayedExpansion = 'on' | 'off'
const DELAYED_EXPANSION_STATES = ['off', 'on'] as const satisfies readonly DelayedExpansion[]

function runWrapper(
  wrapperPath: string,
  env: NodeJS.ProcessEnv,
  // null leaves stdin open to verify the environment guard exits before reading.
  stdinPayload: string | null = PAYLOAD,
  delayedExpansion: DelayedExpansion = 'off',
  keepStdinOpen = false
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', [`/v:${delayedExpansion}`, '/d', '/c', wrapperPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.stdin.destroy()
      child.kill('SIGKILL')
    }, 15_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      setTimeout(() => resolve({ exitCode, stdout, stderr, timedOut }), 250)
    })
    // An abandoned pipe can raise EPIPE after the child exits.
    child.stdin.on('error', () => {})
    if (stdinPayload !== null) {
      if (keepStdinOpen) {
        child.stdin.write(Buffer.from(stdinPayload, 'utf8'))
      } else {
        child.stdin.end(Buffer.from(stdinPayload, 'utf8'))
      }
    }
  })
}

function hookEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
  )
  return { ...base, ...extra }
}

function expectedStdout(eventName: string): string {
  if (eventName === 'PreToolUse') {
    return ANTIGRAVITY_PRE_TOOL_USE_DECISION
  }
  return eventName === 'Stop' ? '{"decision":""}' : '{}'
}

describe('Antigravity Windows hook post command', () => {
  it.each(ANTIGRAVITY_EVENTS)('guards missing-core stdin for $eventName', ({ eventName }) => {
    const script = getWindowsWrapperScript(eventName)
    expect(script).not.toContain('findstr')
    expect(script).toContain('exit /b 0')
  })

  it.each(ANTIGRAVITY_EVENTS)('disables delayed expansion for $eventName', ({ eventName }) => {
    expect(getWindowsWrapperScript(eventName)).toContain('setlocal DisableDelayedExpansion')
  })

  it('posts with the owned runtime and keeps payloads off the command line', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const script = getManagedScript('local', 'C:\\Orca!100%\\Orca.exe')
    expect(script).not.toMatch(/powershell|curl|payload@-/i)
    expect(script).toContain('ORCA_AGENT_HOOK_NODE=C:\\Orca!100%%\\Orca.exe')
    expect(script).toContain('"%ORCA_AGENT_HOOK_NODE%" "%~dp0antigravity-hook-post.cjs"')
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(script).toContain('setlocal DisableDelayedExpansion')
    vi.restoreAllMocks()
  })
})

describe.skipIf(process.platform !== 'win32')('Antigravity Windows hook payload delivery', () => {
  let home = ''
  let server: Server | null = null

  afterEach(() => {
    server?.close()
    server = null
    homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
    if (home) {
      rmSync(home, { recursive: true, force: true })
      home = ''
    }
  })

  it('delivers every event wrapper payload to the listener without spawning PowerShell', async () => {
    // Put ! in the hooks path to exercise core lookup with delayed expansion enabled.
    home = mkdtempSync(join(tmpdir(), 'orca-antigravity-hook!bang-'))
    homedirMock.mockReturnValue(home)
    expect(new AntigravityHookService().install().state).toBe('installed')

    const hooksDir = join(home, '.orca', 'agent-hooks')
    const coreScript = readFileSync(join(hooksDir, 'antigravity-hook.cmd'), 'utf8')
    expect(coreScript).not.toMatch(/powershell/i)

    const listener = await startHookListener()
    server = listener.server
    const env = hookEnvironment({
      USERPROFILE: home,
      HOME: home,
      ORCA_AGENT_HOOK_PORT: String(listener.port),
      ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
      ORCA_PANE_KEY: PANE_KEY,
      ORCA_WORKTREE_ID: WORKTREE_ID
    })

    for (const delayedExpansion of DELAYED_EXPANSION_STATES) {
      for (const event of ANTIGRAVITY_EVENTS) {
        const label = `${event.eventName} (/v:${delayedExpansion})`
        const before = listener.posts.length
        const result = await runWrapper(
          join(hooksDir, event.windowsWrapperFileName),
          env,
          PAYLOAD,
          delayedExpansion
        )

        expect(result.timedOut, `${label} timed out`).toBe(false)
        expect(result.exitCode, `${label} exit code`).toBe(0)
        expect(result.stderr, `${label} stderr`).toBe('')
        expect(result.stdout.trim(), `${label} stdout`).toBe(expectedStdout(event.eventName))

        const posts = listener.posts.slice(before)
        expect(posts, `${label} posted exactly one hook`).toHaveLength(1)
        expect(posts[0].payload, `${label} payload`).toBe(PAYLOAD)
        expect(posts[0].hookEventName, `${label} hook_event_name`).toBe(event.eventName)
        expect(posts[0].paneKey, `${label} paneKey`).toBe(PANE_KEY)
        expect(posts[0].worktreeId, `${label} worktreeId`).toBe(WORKTREE_ID)
        expect(posts[0].token, `${label} token`).toBe(HOOK_TOKEN)
        expect(posts[0].contentType, `${label} content-type`).toContain(
          'application/x-www-form-urlencoded'
        )
      }
    }
  }, 90_000)

  it.each([PAYLOAD, ''])(
    'returns and posts when stdin remains open (%#)',
    async (input) => {
      home = mkdtempSync(join(tmpdir(), 'orca-antigravity-open-'))
      homedirMock.mockReturnValue(home)
      expect(new AntigravityHookService().install().state).toBe('installed')
      const listener = await startHookListener()
      server = listener.server
      const result = await runWrapper(
        join(home, '.orca', 'agent-hooks', 'antigravity-pre-invocation.cmd'),
        hookEnvironment({
          ORCA_AGENT_HOOK_PORT: String(listener.port),
          ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
          ORCA_PANE_KEY: PANE_KEY
        }),
        input,
        'on',
        true
      )
      expect(result.timedOut).toBe(false)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('{}')
      expect(listener.posts).toHaveLength(1)
      expect(listener.posts[0].payload).toBe(input || '{}')
    },
    15_000
  )

  it('still posts a status event when the agent supplies no payload', async () => {
    home = mkdtempSync(join(tmpdir(), 'orca-antigravity-hook-'))
    homedirMock.mockReturnValue(home)
    expect(new AntigravityHookService().install().state).toBe('installed')

    const listener = await startHookListener()
    server = listener.server
    const result = await runWrapper(
      join(home, '.orca', 'agent-hooks', 'antigravity-pre-invocation.cmd'),
      hookEnvironment({
        USERPROFILE: home,
        HOME: home,
        ORCA_AGENT_HOOK_PORT: String(listener.port),
        ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
        ORCA_PANE_KEY: PANE_KEY
      }),
      ''
    )

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(listener.posts).toHaveLength(1)
    expect(listener.posts[0].payload).toBe('{}')
    expect(listener.posts[0].hookEventName).toBe('PreInvocation')
  }, 30_000)

  async function installWithoutCore(): Promise<string> {
    home = mkdtempSync(join(tmpdir(), 'orca-antigravity-fallback-'))
    homedirMock.mockReturnValue(home)
    expect(new AntigravityHookService().install().state).toBe('installed')
    const hooksDir = join(home, '.orca', 'agent-hooks')
    rmSync(join(hooksDir, 'antigravity-hook.cmd'))
    return hooksDir
  }

  it.each(['ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN', 'ORCA_PANE_KEY'])(
    'answers every missing-core event with abandoned stdin and no %s',
    async (missingKey) => {
      const hooksDir = await installWithoutCore()
      const listener = await startHookListener()
      server = listener.server
      const env = hookEnvironment({
        USERPROFILE: home,
        HOME: home,
        ORCA_AGENT_HOOK_PORT: String(listener.port),
        ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
        ORCA_PANE_KEY: PANE_KEY,
        [missingKey]: ''
      })
      for (const event of ANTIGRAVITY_EVENTS) {
        const result = await runWrapper(join(hooksDir, event.windowsWrapperFileName), env, null)
        expect(result.timedOut, event.eventName).toBe(false)
        expect(result.exitCode, event.eventName).toBe(0)
        expect(result.stdout.trim(), event.eventName).toBe(expectedStdout(event.eventName))
        expect(result.stderr, event.eventName).toBe('')
      }
      expect(listener.posts).toHaveLength(0)
    },
    90_000
  )

  it('answers every missing-core event inside a pane without waiting for EOF', async () => {
    const hooksDir = await installWithoutCore()
    const listener = await startHookListener()
    server = listener.server
    const env = hookEnvironment({
      USERPROFILE: home,
      HOME: home,
      ORCA_AGENT_HOOK_PORT: String(listener.port),
      ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
      ORCA_PANE_KEY: PANE_KEY
    })
    for (const event of ANTIGRAVITY_EVENTS) {
      const result = await runWrapper(
        join(hooksDir, event.windowsWrapperFileName),
        env,
        PAYLOAD,
        'on',
        true
      )
      expect(result.timedOut, event.eventName).toBe(false)
      expect(result.exitCode, event.eventName).toBe(0)
      expect(result.stdout.trim(), event.eventName).toBe(expectedStdout(event.eventName))
      expect(result.stderr, event.eventName).toBe('')
    }
    expect(listener.posts).toHaveLength(0)
  }, 60_000)

  it('exits without reading stdin when the pane env is missing', async () => {
    home = mkdtempSync(join(tmpdir(), 'orca-antigravity-hook-'))
    homedirMock.mockReturnValue(home)
    expect(new AntigravityHookService().install().state).toBe('installed')

    const listener = await startHookListener()
    server = listener.server
    const result = await runWrapper(
      join(home, '.orca', 'agent-hooks', 'antigravity-pre-tool-use.cmd'),
      hookEnvironment({ USERPROFILE: home, HOME: home }),
      null
    )

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(ANTIGRAVITY_PRE_TOOL_USE_DECISION)
    expect(listener.posts).toHaveLength(0)
  }, 30_000)
})
