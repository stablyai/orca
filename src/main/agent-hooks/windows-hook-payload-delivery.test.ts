// Why: 1.4.184 registered `conhost.exe --headless <cmd> /d /c <script>` as the Windows
// launcher. conhost is the ConPTY server, not a no-window wrapper: it re-hosts the child
// on a pseudoconsole, so the JSON Claude Code pipes in never reaches the script and the
// curl POST carries no payload. Shape, exit-code and stdout assertions all stayed green
// through it, because none of them ever piped a payload. This suite pipes one and follows
// it to the listener, so a launcher that takes stdin away from the hook fails here (#14818).
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

import { ClaudeHookService } from '../claude/hook-service'
import { getConfigPath, getWindowsManagedLifecycleHook } from '../claude/hook-settings'
import { findGitBash } from './windows-git-bash-path.test-fixture'

const PANE_KEY = 'tab-1:leaf-1'
const HOOK_TOKEN = 'payload-delivery-token'
// Why: exercise the sizes and bytes a real hook carries — a multi-KB body crosses the pipe
// in several chunks, and non-ASCII catches a launcher that recodes stdin through a code page.
const PAYLOAD = JSON.stringify({
  session_id: 'a3f9c1e0-payload-delivery',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo "café 日本語 😀" & echo %PATH% | more' },
  transcript: 'y'.repeat(4096)
})

type HookPost = { payload: string | null; paneKey: string | null; token: string | null }

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
        token: req.headers['x-orca-agent-hook-token'] as string | null
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

function runHookCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    // Why: Claude Code abandons a hook at 10s, so a launcher that strands the payload reads
    // as a timeout to the user; fail the same way instead of hanging the suite.
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
    child.stdin.end(Buffer.from(PAYLOAD, 'utf8'))
  })
}

function hookEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
  )
  return { ...base, ...extra }
}

describe('Windows managed hook launcher', () => {
  // Why: runs on every platform — the live delivery test below can only run on Windows, so
  // this keeps a ConPTY host from being reintroduced unnoticed by a POSIX-only CI leg.
  it('does not re-host the hook on a pseudoconsole', () => {
    const hook = getWindowsManagedLifecycleHook(
      'C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd'
    )
    expect(hook.command).not.toMatch(/conhost/i)
    expect(hook.args).toBeUndefined()
  })
})

describe.skipIf(process.platform !== 'win32')('Windows managed hook payload delivery', () => {
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

  it('delivers the piped payload to the hook listener through cmd.exe and Git Bash', async () => {
    home = mkdtempSync(join(tmpdir(), 'orca-hook-payload-'))
    homedirMock.mockReturnValue(home)
    expect(new ClaudeHookService().install().state).toBe('installed')

    const settings = JSON.parse(readFileSync(getConfigPath(), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    // Why: assert nothing about the launcher's shape here — this test's whole value is
    // that it fails for any launcher that loses the payload, named conhost or not.
    const registeredCommand = settings.hooks.PreToolUse[0].hooks[0].command

    const listener = await startHookListener()
    server = listener.server
    const env = hookEnvironment({
      USERPROFILE: home,
      HOME: home,
      ORCA_AGENT_HOOK_PORT: String(listener.port),
      ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
      ORCA_PANE_KEY: PANE_KEY
    })

    const shells = [
      { name: 'cmd.exe', executable: 'cmd.exe', args: ['/d', '/c', registeredCommand] },
      { name: 'Git Bash', executable: findGitBash(), args: ['-c', registeredCommand] }
    ]
    for (const shell of shells) {
      const before = listener.posts.length
      const result = await runHookCommand(shell.executable, shell.args, env)
      expect(result.timedOut, `${shell.name} timed out`).toBe(false)
      expect(result.exitCode, `${shell.name} exit code`).toBe(0)

      // Why: assert delivery before stdout so a launcher that swallows the payload fails
      // on the symptom users report, not on some downstream difference in what it printed.
      const posts = listener.posts.slice(before)
      expect(posts, `${shell.name} posted exactly one hook`).toHaveLength(1)
      // Why: byte-exact, not "non-empty" — a pseudoconsole host delivers nothing, and a
      // code-page-translating launcher delivers a corrupted body that still looks posted.
      expect(posts[0].payload, `${shell.name} payload`).toBe(PAYLOAD)
      expect(posts[0].paneKey, `${shell.name} paneKey`).toBe(PANE_KEY)
      expect(posts[0].token, `${shell.name} token`).toBe(HOOK_TOKEN)

      expect(result.stderr, `${shell.name} stderr`).toBe('')
      // Why: compat consumers gate the tool call on parseable stdout (#14818).
      expect(result.stdout.trim(), `${shell.name} stdout`).toBe('{}')
    }
    // Why: two shell launches plus a real install can overrun the default under load.
  }, 60_000)
})
