import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'
import type { CliStatusResult } from '../../shared/runtime-types'
import '../../shared/protocol-version'
import { TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY } from '../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { TERMINAL_HANDLERS } from './terminal'

const ORIGINAL_EXIT_CODE = process.exitCode

function terminalClient(
  call: RuntimeClient['call'],
  runtime?: CliStatusResult['runtime']
): RuntimeClient {
  const client = new RuntimeClient('/tmp/orca-terminal-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(call)
  if (runtime) {
    vi.spyOn(client, 'getCliStatus').mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        app: { running: runtime.reachable, pid: runtime.reachable ? 123 : null },
        runtime,
        graph: { state: runtime.reachable ? 'ready' : 'not_running' }
      },
      _meta: { runtimeId: runtime.runtimeId ?? 'none' }
    })
  }
  return client
}

describe('terminal close CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
  })

  it.each([
    [
      'its SSH provider is no longer registered',
      false,
      'Closed terminal term-remote. The PTY was not confirmed stopped: its SSH provider is no longer registered.'
    ],
    [
      'Request "pty.shutdown" timed out after 14250ms',
      true,
      'Closed terminal term-remote. The PTY was not confirmed stopped: Request "pty.shutdown" timed out after 14250ms. The kill retries when the host reconnects.'
    ],
    // An older host never reports a recorded kill, so the same reason promises nothing.
    [
      'Request "pty.shutdown" timed out after 14250ms',
      false,
      'Closed terminal term-remote. The PTY was not confirmed stopped: Request "pty.shutdown" timed out after 14250ms.'
    ]
  ])(
    'reports an unverifiable stop (%s, kill recorded: %s) as a committed close with exit code 1',
    async (ptyStopReason, pendingKillRecorded, message) => {
      process.exitCode = undefined
      const close = {
        handle: 'term-remote',
        tabId: 'tab-1',
        ptyKilled: false,
        ptyStopVerdict: 'unverifiable' as const,
        ptyStopReason,
        ...(pendingKillRecorded ? { pendingKillRecorded: true as const } : {})
      }
      const call = vi.fn().mockResolvedValue({
        id: 'req-close',
        ok: true,
        result: { close },
        _meta: { runtimeId: 'runtime-1' }
      })
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})

      await TERMINAL_HANDLERS['terminal close']({
        flags: new Map([['terminal', close.handle]]),
        client: terminalClient(call),
        cwd: '/tmp/worktree',
        json: true
      })

      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'terminal_stop_unverifiable', message, data: { close } }
      })
      expect(process.exitCode).toBe(1)
    }
  )

  it('fails JSON when bulk close cannot verify every PTY stopped', async () => {
    process.exitCode = undefined
    const call = vi.fn().mockResolvedValue({
      result: {
        closed: 2,
        stopped: 1,
        retiredSurfaces: true,
        ptyStopVerdict: 'unverifiable',
        ptyStopReason: 'the SSH host disconnected'
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: new Map<string, string | true>([
        ['worktree', 'id:repo::/worktree'],
        ['all', true]
      ]),
      client: terminalClient(call),
      cwd: '/tmp/worktree',
      json: true
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'terminal_stop_unverifiable',
        data: { close: { closed: 2, stopped: 1, ptyStopVerdict: 'unverifiable' } }
      }
    })
    expect(process.exitCode).toBe(1)
  })
})

describe('terminal send CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
  })

  it('fails closed when the host downgrades after the prompt capability preflight', async () => {
    const response = {
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 8 } },
      _meta: { runtimeId: 'old-runtime-after-restart' }
    }
    const call = vi.fn().mockResolvedValue(response)
    const client = terminalClient(call, {
      state: 'ready',
      reachable: true,
      runtimeId: 'new-runtime-before-restart',
      capabilities: [TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY]
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const error = await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'continue'],
        ['enter', true],
        ['retry-request', '11111111-1111-4111-8111-111111111111'],
        ['wait-submit', '3']
      ]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })
      .then(() => undefined)
      .catch((caught: unknown) => caught)

    expect(call).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ agentPrompt: true, waitSubmitMs: 3_000 }),
      {
        terminalPromptPreflight: { runtimeId: 'new-runtime-before-restart' },
        orchestrationRequestId: '11111111-1111-4111-8111-111111111111',
        timeoutMs: 13_000
      }
    )
    expect(error).toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining('cannot prove whether the prompt was delivered'),
      data: {
        deliveryOutcome: 'unknown',
        retrySafe: false,
        nextSteps: expect.arrayContaining([expect.stringContaining('Inspect the terminal output')])
      }
    })
    expect(log).not.toHaveBeenCalled()
  })
})

describe('terminal agent-status CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
  })

  it.each(['working', 'permission', 'idle'] as const)(
    'prints terminal agent status JSON for %s',
    async (status) => {
      process.exitCode = undefined
      const call = vi.fn().mockResolvedValue({
        id: 'req-agent-status',
        ok: true,
        result: {
          agentStatus: {
            handle: 'term_worker',
            isRunningAgent: true,
            status
          }
        },
        _meta: { runtimeId: 'runtime-1' }
      })
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})

      await TERMINAL_HANDLERS['terminal agent-status']({
        flags: new Map([['terminal', 'term_worker']]),
        client: terminalClient(call),
        cwd: '/tmp/worktree',
        json: true
      })

      expect(call).toHaveBeenCalledWith('terminal.agentStatus', { terminal: 'term_worker' })
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).result.agentStatus).toEqual({
        handle: 'term_worker',
        isRunningAgent: true,
        status
      })
    }
  )

  it('prints terminal agent status in human-readable mode', async () => {
    process.exitCode = undefined
    const call = vi.fn().mockResolvedValue({
      id: 'req-agent-status',
      ok: true,
      result: {
        agentStatus: {
          handle: 'term_worker',
          isRunningAgent: true,
          status: 'permission'
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal agent-status']({
      flags: new Map([['terminal', 'term_worker']]),
      client: terminalClient(call),
      cwd: '/tmp/worktree',
      json: false
    })

    expect(call).toHaveBeenCalledWith('terminal.agentStatus', { terminal: 'term_worker' })
    expect(String(log.mock.calls[0]?.[0])).toBe(
      ['handle: term_worker', 'isRunningAgent: true', 'status: permission'].join('\n')
    )
  })

  it('prints null status for a terminal that is not running an agent', async () => {
    process.exitCode = undefined
    const call = vi.fn().mockResolvedValue({
      id: 'req-agent-status',
      ok: true,
      result: {
        agentStatus: {
          handle: 'term_shell',
          isRunningAgent: false,
          status: null
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal agent-status']({
      flags: new Map([['terminal', 'term_shell']]),
      client: terminalClient(call),
      cwd: '/tmp/worktree',
      json: false
    })

    expect(call).toHaveBeenCalledWith('terminal.agentStatus', { terminal: 'term_shell' })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('isRunningAgent: false')
    expect(printed).toContain('status: null')
  })
})
