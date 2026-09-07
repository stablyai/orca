// Why (#15117): shape assertions cannot catch a curl line that posts nothing, so this suite
// pipes a real payload through the installed wrappers and follows it to a live listener.
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
import { getManagedScript } from './hook-script'

// Why (#9358/#9941): `!` is legal in a Windows path and in a pane key. Under inherited
// delayed expansion cmd eats it out of a percent-expanded curl argument, so bake one into
// every value the script forwards rather than asserting the `setlocal` line alone.
const PANE_KEY = 'tab-1:leaf-1!bang'
const WORKTREE_ID = 'repo-1::C:\\Users\\alice\\orca\\feature!branch'
const HOOK_TOKEN = 'antigravity-payload-delivery-token'
// Why: exercise the sizes and bytes a real hook carries — a multi-KB body crosses the pipe
// in several chunks, and non-ASCII catches a launcher that recodes stdin through a code page.
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

function runWrapper(
  wrapperPath: string,
  env: NodeJS.ProcessEnv,
  // Why: `null` abandons stdin instead of closing it — the shape a caller outside an Orca
  // pane produces, and the only way to prove the env guard exits before reading (#11549).
  stdinPayload: string | null = PAYLOAD
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    // Why: mirror how Antigravity spawns the hook — `cmd /c <bare .cmd path>`, the exact
    // chain in the bug report's process trace.
    const child = spawn('cmd.exe', ['/d', '/c', wrapperPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
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
      // Why: curl exits once the POST is written; give the listener a beat to finish reading it.
      setTimeout(() => resolve({ exitCode, stdout, stderr, timedOut }), 250)
    })
    // Why: an abandoned pipe raises EPIPE once the child exits; swallow it so the run still
    // resolves on the child's own terms.
    child.stdin.on('error', () => {})
    if (stdinPayload !== null) {
      child.stdin.end(Buffer.from(stdinPayload, 'utf8'))
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

// Why: runs on every platform — the live delivery suite below is Windows-only, so this
// keeps a POSIX-only CI leg from letting the interpreter back into the hot path.
describe('Antigravity Windows hook post command', () => {
  it('posts through curl.exe rather than a PowerShell interpreter', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const script = getManagedScript('local')

    expect(script).not.toMatch(/powershell/i)
    expect(script).toContain('"%SystemRoot%\\System32\\curl.exe" -sS -X POST')
    expect(script).toContain('http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/antigravity')
    expect(script).toContain('--data-urlencode "hook_event_name=%ORCA_ANTIGRAVITY_EVENT%"')
    // Why: keep the payload off the command line so multi-KB tool output cannot trip an
    // EDR oversized-command-line rule.
    expect(script).toContain('--data-urlencode "payload@-"')
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
    home = mkdtempSync(join(tmpdir(), 'orca-antigravity-hook-'))
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

    for (const event of ANTIGRAVITY_EVENTS) {
      const label = event.eventName
      const before = listener.posts.length
      const result = await runWrapper(join(hooksDir, event.windowsWrapperFileName), env)

      expect(result.timedOut, `${label} timed out`).toBe(false)
      expect(result.exitCode, `${label} exit code`).toBe(0)
      expect(result.stderr, `${label} stderr`).toBe('')
      // Why: Antigravity reads silence on PreToolUse as deny (#2426), so the gate answer
      // must survive the transport change.
      expect(result.stdout.trim(), `${label} stdout`).toBe(expectedStdout(label))

      const posts = listener.posts.slice(before)
      expect(posts, `${label} posted exactly one hook`).toHaveLength(1)
      // Why: byte-exact, not "non-empty" — PowerShell recoded this body through the console
      // code page, and a silently corrupted payload still looks posted.
      expect(posts[0].payload, `${label} payload`).toBe(PAYLOAD)
      expect(posts[0].hookEventName, `${label} hook_event_name`).toBe(label)
      // Why: the `!` in both values is the delayed-expansion regression guard.
      expect(posts[0].paneKey, `${label} paneKey`).toBe(PANE_KEY)
      expect(posts[0].worktreeId, `${label} worktreeId`).toBe(WORKTREE_ID)
      expect(posts[0].token, `${label} token`).toBe(HOOK_TOKEN)
      expect(posts[0].contentType, `${label} content-type`).toContain(
        'application/x-www-form-urlencoded'
      )
    }
    // Why: five wrapper launches plus a real install can overrun the default under load.
  }, 60_000)

  // Why (#15117): Antigravity fires some events with no stdin at all. PowerShell substituted
  // `{}` before posting; curl forwards the empty body, so prove the post still happens — the
  // listener's matching allowance is covered in agent-hook-listener-antigravity.test.ts.
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
    // Why: curl drops a `--data-urlencode name@-` field entirely when stdin is empty, so the
    // event reaches the listener with no `payload` key — not an empty one.
    expect(listener.posts[0].payload).toBeNull()
    expect(listener.posts[0].hookEventName).toBe('PreInvocation')
  }, 30_000)

  it('exits without reading stdin when the pane env is missing', async () => {
    home = mkdtempSync(join(tmpdir(), 'orca-antigravity-hook-'))
    homedirMock.mockReturnValue(home)
    expect(new AntigravityHookService().install().state).toBe('installed')

    const listener = await startHookListener()
    server = listener.server
    // Why (#11549): outside an Orca pane the caller may abandon stdin rather than close it,
    // so the guard must exit before the read — otherwise the console lingers indefinitely.
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
