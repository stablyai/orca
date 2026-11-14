import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as OsModule from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { z } from 'zod'
import { tokenizeCommandLine } from '../../shared/agent-status/process/agent-command-line-entrypoint'
import { spawnProcess } from '@orca/process-host'
import { AntigravityHookService } from './hook-service'
import { ANTIGRAVITY_PRE_TOOL_USE_DECISION } from './hook-events'
import { wrapPosixHookCommand } from '../agent-hooks/installation/commands/posix-hook-command'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'
import { readAgentProcess } from '../../shared/agent-status/process/agent-process-presence-probe'
import {
  buildSpoolHookBody,
  readSpoolFile
} from '../../shared/agent-hook-listener/transport/agent-hook-spool'

const { homeMock } = vi.hoisted(() => ({ homeMock: vi.fn<() => string>() }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof OsModule>()),
  homedir: homeMock
}))

const hooksSchema = z.object({
  'orca-status': z.record(
    z.string(),
    z.array(
      z.object({
        command: z.string().optional(),
        hooks: z.array(z.object({ command: z.string() })).optional()
      })
    )
  )
})

function installedCommand(home: string, event: string): string {
  homeMock.mockReturnValue(home)
  expect(new AntigravityHookService().install().state).toBe('installed')
  const config = hooksSchema.parse(
    JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf8'))
  )
  const hook = config['orca-status'][event]?.[0]
  const command = hook?.command ?? hook?.hooks?.[0]?.command
  if (!command) {
    throw new Error(`Missing ${event} hook`)
  }
  return command
}

function invoke(command: string, input: string, env: NodeJS.ProcessEnv) {
  const [program, ...args] = tokenizeCommandLine(command)
  if (!program) {
    throw new Error('Missing executable')
  }
  expect(program).toBe('/bin/sh')
  return new Promise<{ code: number | null; stdout: string; elapsedMs: number }>(
    (resolve, reject) => {
      const start = Date.now()
      const child = spawnProcess({ program, args, env })
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stdin.on('error', () => {})
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout: stdout.trim(), elapsedMs: Date.now() - start })
      })
      // agy may leave stdin open after sending one JSON value.
      if (input) {
        child.stdin.write(Buffer.from(input))
      }
    }
  )
}

let home = ''
afterEach(() => {
  if (home) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('Antigravity POSIX hook executable contract', () => {
  it.each(['current', 'old'] as const)(
    'delivers UTF-8 JSON and %s command ownership with open stdin',
    async (version) => {
      home = mkdtempSync(join(tmpdir(), "orca-agy-hook-'quoted-"))
      const payload = JSON.stringify({
        tool_name: 'run_command',
        tool_input: { command: 'echo café 日本語 😀' }
      })
      const posts: URLSearchParams[] = []
      const server = createServer((req, res) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => {
          body += chunk
        })
        req.on('end', () => {
          posts.push(new URLSearchParams(body))
          res.end('{}')
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        throw new Error('Missing listener port')
      }
      try {
        const currentCommand = installedCommand(home, 'PreToolUse')
        const command =
          version === 'current'
            ? currentCommand
            : `/bin/sh -c ${quotePosixShell(wrapPosixHookCommand(join(home, '.orca', 'agent-hooks', 'antigravity-hook.sh'), { ORCA_ANTIGRAVITY_EVENT: 'PreToolUse' }, { fallbackStdout: ANTIGRAVITY_PRE_TOOL_USE_DECISION }))}`
        const result = await invoke(command, payload, {
          ...process.env,
          ORCA_AGENT_HOOK_ENDPOINT: '',
          ORCA_AGENT_HOOK_PORT: String(address.port),
          ORCA_AGENT_HOOK_TOKEN: 'test-only-token',
          ORCA_PANE_KEY: 'test-pane',
          ORCA_HOOK_AGENT_PID: version === 'current' ? '2' : '',
          TMUX: '/tmp/agy-test.sock,123,0',
          TMUX_PANE: '%4'
        })
        expect(result.code).toBe(0)
        expect(result.stdout).toBe('{"decision":"ask"}')
        expect(result.elapsedMs).toBeLessThan(8000)
        expect(posts).toHaveLength(1)
        expect(posts[0]?.get('payload')).toBe(payload)
        expect(posts[0]?.get('hook_event_name')).toBe('PreToolUse')
        expect(posts[0]?.get('tmuxPane')).toBe('%4 /tmp/agy-test.sock')
        if (version === 'current') {
          const observed = await readAgentProcess(process.pid)
          expect(observed.verdict).toBe('live')
          expect(JSON.parse(posts[0]?.get('agentProcess') || '{}')).toEqual({
            pid: process.pid,
            platform: process.platform,
            startTime: observed.verdict === 'live' ? observed.startTime : undefined
          })
        } else {
          expect(posts[0]?.get('agentProcess')).toBe('')
        }
      } finally {
        server.close()
      }
    },
    10000
  )

  it('preserves process and tmux evidence in startup spool bodies', async () => {
    home = mkdtempSync(join(tmpdir(), 'orca-agy-spool-'))
    const endpoint = join(home, 'endpoint.sh')
    writeFileSync(endpoint, '# endpoint not ready\n')
    const result = await invoke(installedCommand(home, 'PreInvocation'), '{}', {
      ...process.env,
      ORCA_AGENT_HOOK_ENDPOINT: endpoint,
      ORCA_AGENT_HOOK_PORT: '',
      ORCA_AGENT_HOOK_TOKEN: '',
      ORCA_PANE_KEY: 'test-pane',
      ORCA_HOOK_AGENT_PID: '2',
      TMUX: '/tmp/agy-test.sock,123,0',
      TMUX_PANE: '%4'
    })
    expect(result.code).toBe(0)
    const spool = join(home, 'spool')
    const { records } = readSpoolFile(join(spool, readdirSync(spool)[0]))
    expect(records).toHaveLength(1)
    const body = buildSpoolHookBody(records[0])
    expect(JSON.parse(String(body.agentProcess))).toMatchObject({ pid: process.pid })
    expect(body.tmuxPane).toBe('%4 /tmp/agy-test.sock')
    expect(body.hookEventName).toBe('PreInvocation')
  })

  it('returns after a bounded wait when stdin has no bytes and remains open', async () => {
    home = mkdtempSync(join(tmpdir(), 'orca-agy-empty-hook-'))
    const result = await invoke(installedCommand(home, 'PreInvocation'), '', {
      ...process.env,
      ORCA_AGENT_HOOK_ENDPOINT: '',
      ORCA_AGENT_HOOK_PORT: '',
      ORCA_AGENT_HOOK_TOKEN: '',
      ORCA_PANE_KEY: ''
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('{}')
    expect(result.elapsedMs).toBeLessThan(8000)
  }, 10000)
})
