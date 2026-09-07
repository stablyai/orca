import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { parseArgs } from '../args'
import { printHelp } from '../help'
import { COMMAND_SPECS } from '../specs'
import { TERMINAL_HANDLERS } from './terminal'

const ORIGINAL_EXIT_CODE = process.exitCode

describe('terminal close CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
  })

  it('keeps the default close RPC unchanged', async () => {
    process.exitCode = undefined
    const call = vi.fn().mockResolvedValue({
      id: 'req-close',
      ok: true,
      result: { close: { handle: 'term-1', tabId: 'tab-1', ptyKilled: true } },
      _meta: { runtimeId: 'runtime-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: new Map([['terminal', 'term-1']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.close', { terminal: 'term-1' })
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      result: { close: { ptyKilled: true } }
    })
    expect(process.exitCode).toBeUndefined()
  })

  it('reports an unverifiable PTY stop as a failing JSON outcome', async () => {
    process.exitCode = undefined
    const close = {
      handle: 'term-remote',
      tabId: 'tab-1',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable' as const,
      ptyStopReason: 'its SSH provider is no longer registered'
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
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'terminal_stop_unverifiable',
        message: expect.stringContaining('unverifiable'),
        data: { close }
      }
    })
    expect(process.exitCode).toBe(1)
  })

  it('reports a live PTY stop as a failing human outcome', async () => {
    process.exitCode = undefined
    const close = {
      handle: 'term-live',
      tabId: 'tab-1',
      ptyKilled: false,
      ptyStopVerdict: 'live' as const
    }
    const call = vi.fn().mockResolvedValue({ result: { close } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: new Map([['terminal', close.handle]]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: false
    })

    expect(log).toHaveBeenCalledWith(expect.stringContaining('The PTY is live.'))
    expect(process.exitCode).toBe(1)
  })

  it('routes --tab to the durable whole-tab RPC', async () => {
    process.exitCode = undefined
    const parsed = parseArgs(['terminal', 'close', '--terminal', 'term-1', '--tab'])
    const call = vi.fn().mockResolvedValue({
      result: {
        close: {
          handle: 'term-1',
          tabId: 'tab-1',
          closeMode: 'tab',
          ptyKilled: false
        }
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: parsed.flags,
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(parsed.flags.get('tab')).toBe(true)
    expect(call).toHaveBeenCalledWith('terminal.closeTab', { terminal: 'term-1' })
    expect(process.exitCode).toBeUndefined()
  })

  it('routes --worktree --all to authoritative durable bulk close', async () => {
    const parsed = parseArgs(['terminal', 'close', '--worktree', 'id:repo::/worktree', '--all'])
    const call = vi.fn().mockResolvedValue({
      result: { closed: 2, stopped: 3, retiredSurfaces: true }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: parsed.flags,
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.closeAll', {
      worktree: 'id:repo::/worktree'
    })
  })

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
      client: { call } as unknown as RuntimeClient,
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

  it.each([
    [new Map<string, string | true>([['worktree', 'active']]), 'requires --all'],
    [
      new Map<string, string | true>([
        ['worktree', 'active'],
        ['all', true],
        ['terminal', 'term-1']
      ]),
      'cannot be combined'
    ],
    [new Map<string, string | true>([['all', true]]), 'Missing required --worktree']
  ])('rejects ambiguous bulk-close flags', async (flags, message) => {
    await expect(
      TERMINAL_HANDLERS['terminal close']({
        flags,
        client: { call: vi.fn() } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toThrow(message)
  })

  it('fails safely before mutation when the host predates bulk close', async () => {
    const call = vi
      .fn()
      .mockRejectedValue(
        new RuntimeClientError('method_not_found', 'Unknown method: terminal.closeAll')
      )

    await expect(
      TERMINAL_HANDLERS['terminal close']({
        flags: new Map<string, string | true>([
          ['worktree', 'active'],
          ['all', true]
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
  })

  it('documents that --tab waits for durable persistence', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printHelp(COMMAND_SPECS, ['terminal', 'close'])

    const help = String(log.mock.calls[0]?.[0])
    expect(help).toContain('--worktree <selector> --all')
    expect(help).toContain('durable persistence')
  })

  it('hides legacy stop from terminal command discovery', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printHelp(COMMAND_SPECS, ['terminal'])

    const help = String(log.mock.calls[0]?.[0])
    expect(help).toContain('close')
    expect(help).not.toContain('stop')
  })

  it('keeps root help aligned with the canonical close command', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printHelp(COMMAND_SPECS)

    const help = String(log.mock.calls[0]?.[0])
    expect(help).toContain(
      'terminal close            Close one terminal, its whole tab with --tab, or all in a worktree'
    )
    expect(help).not.toContain('terminal stop')
  })
})

describe('terminal send CLI', () => {
  const promptClient = (call: ReturnType<typeof vi.fn>, supported: boolean) =>
    ({
      call,
      getCliStatus: vi.fn().mockResolvedValue({
        result: {
          runtime: {
            reachable: true,
            runtimeId: 'runtime-current',
            capabilities: supported ? [TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY] : []
          }
        }
      })
    }) as unknown as RuntimeClient

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
  })

  it('marks combined text and Enter as an agent prompt candidate', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        send: {
          handle: 'term-1',
          accepted: true,
          bytesWritten: 7,
          prompt: {
            requestId: '11111111-1111-4111-8111-111111111111',
            stages: ['input_accepted'],
            provider: 'codex',
            observation: 'supported',
            processIncarnation: 'inc-1',
            generation: 1,
            baselineWorkingSequence: 0
          }
        }
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'review'],
        ['enter', true]
      ]),
      client: promptClient(call, true),
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith(
      'terminal.send',
      {
        terminal: 'term-1',
        text: 'review',
        enter: true,
        interrupt: false,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      },
      { terminalPromptPreflight: { runtimeId: 'runtime-current' } }
    )
  })

  it('carries the swallowed-Enter warning into the --json receipt', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        send: {
          handle: 'term-1',
          accepted: true,
          bytesWritten: 7,
          prompt: {
            requestId: 'prompt-swallowed',
            stages: ['input_accepted'],
            provider: 'claude',
            observation: 'supported',
            processIncarnation: 'inc-1',
            generation: 1,
            baselineWorkingSequence: 0
          }
        }
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'review'],
        ['enter', true]
      ]),
      client: promptClient(call, true),
      cwd: '/tmp/worktree',
      json: true
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0])).result.warnings).toEqual([
      expect.stringContaining('no turn start was observed')
    ])
  })

  it('explains that Structured Chat blocked a refused send and how to recover', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        send: {
          handle: 'term-1',
          accepted: false,
          bytesWritten: 0,
          agentSessionRefusal: {
            code: 'agent_session_conflict',
            sessionId: 'session-1',
            ownerRuntimeKind: 'native',
            handoffStage: null,
            ownerPid: 4242,
            runtimeFence: 7
          }
        }
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    process.exitCode = undefined
    const client = promptClient(call, true)

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'review'],
        ['enter', true]
      ]),
      client,
      cwd: '/tmp/worktree',
      json: false
    })

    expect(client.getCliStatus).toHaveBeenCalledOnce()
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/Structured Chat.*Switch it to Terminal.*orca terminal send/s)
    )
    expect(process.exitCode).toBe(1)
  })

  it('keeps text-only and bare Enter sends as direct terminal input', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 1 } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'x']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })
    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['enter', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenNthCalledWith(1, 'terminal.send', {
      terminal: 'term-1',
      text: 'x',
      enter: false,
      interrupt: false,
      client: { id: 'orca-cli', type: 'desktop' }
    })
    expect(call).toHaveBeenNthCalledWith(2, 'terminal.send', {
      terminal: 'term-1',
      text: undefined,
      enter: true,
      interrupt: false,
      client: { id: 'orca-cli', type: 'desktop' }
    })
  })

  it('passes retry identity and observation wait only for agent prompts', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        send: {
          handle: 'term-1',
          accepted: true,
          bytesWritten: 8,
          prompt: {
            requestId: '11111111-1111-4111-8111-111111111111',
            stages: ['input_accepted'],
            provider: 'codex',
            observation: 'supported',
            processIncarnation: 'inc-1',
            generation: 1,
            baselineWorkingSequence: 1
          }
        }
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'continue'],
        ['enter', true],
        ['retry-request', '11111111-1111-4111-8111-111111111111'],
        ['wait-submit', '3']
      ]),
      client: promptClient(call, true),
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ agentPrompt: true, waitSubmitMs: 3_000 }),
      {
        terminalPromptPreflight: { runtimeId: 'runtime-current' },
        orchestrationRequestId: '11111111-1111-4111-8111-111111111111',
        timeoutMs: 13_000
      }
    )
  })

  it('fails closed when the host downgrades after the prompt capability preflight', async () => {
    const response = {
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 8 } },
      _meta: { runtimeId: 'old-runtime-after-restart' }
    }
    const call = vi.fn().mockResolvedValue(response)
    const client = {
      call,
      getCliStatus: vi.fn().mockResolvedValue({
        result: {
          runtime: {
            reachable: true,
            runtimeId: 'new-runtime-before-restart',
            capabilities: [TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY]
          }
        }
      })
    } as unknown as RuntimeClient
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
      data: {
        deliveryOutcome: 'unknown',
        retrySafe: false,
        nextSteps: expect.arrayContaining([expect.stringContaining('Inspect the terminal output')])
      }
    })
    expect((error as Error).message).toContain('cannot prove whether the prompt was delivered')
    expect((response.result.send as { prompt?: unknown }).prompt).toBeUndefined()
    expect(log).not.toHaveBeenCalled()
  })

  it('labels an old-host response as non-idempotent without claiming submission', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 7 } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'review'],
        ['enter', true]
      ]),
      client: promptClient(call, false),
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ agentPrompt: true }),
      { legacyTerminalPrompt: true }
    )
    expect(call.mock.results[0]?.value).toBeDefined()
    const response = await call.mock.results[0]?.value
    expect(response.result.send.prompt).toEqual({
      requestId: 'unsupported-old-host',
      stages: ['input_accepted'],
      provider: 'old-host',
      observation: 'unsupported',
      processIncarnation: 'unknown',
      generation: 0,
      baselineWorkingSequence: 0
    })
  })

  it('does not fabricate an accepted prompt receipt for an old-host refusal', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        send: {
          handle: 'term-1',
          accepted: false,
          bytesWritten: 0,
          refusedReason: 'permission'
        }
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'review'],
        ['enter', true]
      ]),
      client: promptClient(call, false),
      cwd: '/tmp/worktree',
      json: false
    })

    const response = await call.mock.results[0]?.value
    expect(response.result.send.prompt).toBeUndefined()
    expect(String(log.mock.calls[0]?.[0])).toBe('Input refused by term-1: permission.')
  })

  it('refuses old-host retry before sending any input', async () => {
    const call = vi.fn()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const error = await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'review'],
        ['enter', true],
        ['retry-request', '11111111-1111-4111-8111-111111111111']
      ]),
      client: {
        call,
        getCliStatus: vi.fn().mockResolvedValue({
          result: { runtime: { reachable: true, capabilities: [] } }
        })
      } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })
      .then(() => undefined)
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'incompatible_runtime' })
    expect((error as Error).message).toContain(
      'updating the host cannot make this specific retry idempotent'
    )
    expect((error as Error).message).not.toContain('omit --retry-request')
    expect(call).not.toHaveBeenCalled()
  })

  it('preserves retry identity after a pre-write host failure', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new RuntimeClientError('internal_error', 'terminal_not_writable'))
      .mockResolvedValueOnce({
        result: {
          send: {
            handle: 'term-1',
            accepted: true,
            bytesWritten: 13,
            prompt: {
              requestId: '22222222-2222-4222-8222-222222222222',
              stages: ['input_accepted'],
              provider: 'codex',
              observation: 'supported',
              processIncarnation: 'inc-1',
              generation: 1,
              baselineWorkingSequence: 0
            }
          }
        }
      })
    const client = promptClient(call, true)
    const flags = new Map<string, string | true>([
      ['terminal', 'term-1'],
      ['text', 'retry safely'],
      ['enter', true],
      ['retry-request', '22222222-2222-4222-8222-222222222222']
    ])
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      TERMINAL_HANDLERS['terminal send']({ flags, client, cwd: '/tmp/worktree', json: true })
    ).rejects.toMatchObject({ message: 'terminal_not_writable' })
    await TERMINAL_HANDLERS['terminal send']({
      flags,
      client,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls.map((args) => args[2])).toEqual([
      {
        terminalPromptPreflight: { runtimeId: 'runtime-current' },
        orchestrationRequestId: '22222222-2222-4222-8222-222222222222'
      },
      {
        terminalPromptPreflight: { runtimeId: 'runtime-current' },
        orchestrationRequestId: '22222222-2222-4222-8222-222222222222'
      }
    ])
  })
})
