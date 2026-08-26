// Why: Antigravity can omit stdin or leave the pipe open until the hook exits.
// Shape assertions on the script text cannot catch an unbounded `cat`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { ANTIGRAVITY_PRE_TOOL_USE_DECISION } from './hook-events'
import { ANTIGRAVITY_POSIX_STDIN_WATCHDOG_SECONDS } from './hook-script'

const PANE_KEY = 'tab-1:leaf-1'
const WORKTREE_ID = 'repo-1::/tmp/feature'
const HOOK_TOKEN = 'antigravity-posix-payload-delivery-token'
const CLOSED_PAYLOAD = `${JSON.stringify({
  fullyIdle: true,
  toolCall: { name: 'run_command', args: { CommandLine: 'pwd' } },
  transcriptPath: '/tmp/antigravity-transcript.jsonl'
})}\n`
const ABANDONED_LINE_PAYLOAD = `${JSON.stringify({ fullyIdle: false })}  \n`

type HookPost = {
  payload: string | null
  hookEventName: string | null
  token: string | null
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
        hookEventName: form.get('hook_event_name'),
        token: (req.headers['x-orca-agent-hook-token'] as string | undefined) ?? null
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

type HookRun = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  elapsedMs: number
}

// Includes curl's 1.5s bound and the listener settle delay.
const EXIT_BUDGET_MS = (ANTIGRAVITY_POSIX_STDIN_WATCHDOG_SECONDS + 3) * 1000

function runScript(
  scriptPath: string,
  env: NodeJS.ProcessEnv,
  stdinPayload: string | null,
  closeStdin: boolean
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn('/bin/sh', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], env })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, EXIT_BUDGET_MS)
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
      setTimeout(
        () =>
          resolve({
            exitCode,
            stdout,
            stderr,
            timedOut,
            elapsedMs: Date.now() - startedAt
          }),
        250
      )
    })
    child.stdin.on('error', () => {})
    if (stdinPayload !== null) {
      child.stdin.write(stdinPayload)
    }
    if (closeStdin) {
      child.stdin.end()
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

describe.skipIf(process.platform === 'win32')('Antigravity POSIX hook payload delivery', () => {
  let home: string | undefined
  let server: Server | undefined

  afterEach(() => {
    server?.close()
    server = undefined
    if (home) {
      rmSync(home, { recursive: true, force: true })
      home = undefined
    }
  })

  async function installAndListen(): Promise<{
    scriptPath: string
    port: number
    posts: HookPost[]
  }> {
    home = mkdtempSync(join(tmpdir(), 'orca-antigravity-posix-hook-'))
    homedirMock.mockReturnValue(home)
    expect(new AntigravityHookService().install().state).toBe('installed')
    const listener = await startHookListener()
    server = listener.server
    return {
      scriptPath: join(home, '.orca', 'agent-hooks', 'antigravity-hook.sh'),
      port: listener.port,
      posts: listener.posts
    }
  }

  function orcaEnv(port: number): NodeJS.ProcessEnv {
    return hookEnvironment({
      HOME: home,
      ORCA_AGENT_HOOK_PORT: String(port),
      ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
      ORCA_PANE_KEY: PANE_KEY,
      ORCA_TAB_ID: 'tab-1',
      ORCA_WORKTREE_ID: WORKTREE_ID,
      ORCA_AGENT_HOOK_ENV: 'production',
      ORCA_AGENT_HOOK_VERSION: '1',
      ORCA_AGENT_HOOK_ENDPOINT: ''
    })
  }

  it.each(['PreInvocation', 'PreToolUse', 'Stop'] as const)(
    'exits when %s stdin is abandoned with Orca env present',
    async (eventName) => {
      const { scriptPath, port, posts } = await installAndListen()
      const result = await runScript(
        scriptPath,
        { ...orcaEnv(port), ORCA_ANTIGRAVITY_EVENT: eventName },
        null,
        false
      )

      expect(result.timedOut).toBe(false)
      expect(result.exitCode).toBe(0)
      expect(result.elapsedMs).toBeLessThan(EXIT_BUDGET_MS)
      expect(result.stdout.trim()).toBe(expectedStdout(eventName))
      expect(result.stderr).toBe('')
      expect(posts).toEqual([{ payload: '{}', hookEventName: eventName, token: HOOK_TOKEN }])
    }
  )

  it('exits when a payload line is written but stdin is never closed', async () => {
    const { scriptPath, port, posts } = await installAndListen()
    const endpointPath = join(home!, 'empty-path-endpoint.sh')
    writeFileSync(endpointPath, 'curl() { /usr/bin/curl "$@"; }\n')
    const result = await runScript(
      scriptPath,
      {
        ...orcaEnv(port),
        PATH: '',
        ORCA_AGENT_HOOK_ENDPOINT: endpointPath,
        ORCA_ANTIGRAVITY_EVENT: 'Stop'
      },
      ABANDONED_LINE_PAYLOAD,
      false
    )

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.elapsedMs).toBeLessThan(EXIT_BUDGET_MS)
    expect(result.stdout.trim()).toBe('{"decision":""}')
    expect(result.stderr).toBe('')
    expect(posts).toEqual([
      {
        payload: ABANDONED_LINE_PAYLOAD.slice(0, -1),
        hookEventName: 'Stop',
        token: HOOK_TOKEN
      }
    ])
  })

  it('posts a closed-stdin Stop payload byte-exact', async () => {
    const { scriptPath, port, posts } = await installAndListen()
    const result = await runScript(
      scriptPath,
      { ...orcaEnv(port), ORCA_ANTIGRAVITY_EVENT: 'Stop' },
      CLOSED_PAYLOAD,
      true
    )

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('{"decision":""}')
    expect(result.stderr).toBe('')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.hookEventName).toBe('Stop')
    expect(posts[0]?.payload).toBe(CLOSED_PAYLOAD.slice(0, -1))
  })

  it('exits without waiting the watchdog when Orca env is missing', async () => {
    const { scriptPath, port } = await installAndListen()
    const result = await runScript(
      scriptPath,
      hookEnvironment({
        HOME: home,
        ORCA_ANTIGRAVITY_EVENT: 'PreToolUse',
        ORCA_AGENT_HOOK_PORT: String(port),
        ORCA_AGENT_HOOK_ENDPOINT: ''
      }),
      null,
      false
    )

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.elapsedMs).toBeLessThan(500)
    expect(result.stdout.trim()).toBe(ANTIGRAVITY_PRE_TOOL_USE_DECISION)
    expect(result.stderr).toBe('')
  })
})
