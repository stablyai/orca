import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode
const originalCliCommand = process.env.ORCA_CLI_COMMAND

type RecoveryWorkerStartResult = {
  taskId: string
  dispatchId: string
  state: string
  effects: unknown[]
  residualResources: unknown[]
  nextCommands: string[]
}

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { BOOLEAN_FLAGS, parseArgs } from '../args'
import { formatCommandHelp } from '../help'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from '../specs/orchestration-worker-specs'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

describe('orchestration worker-start CLI contract', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
    process.exitCode = undefined
    delete process.env.ORCA_CLI_COMMAND
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    if (originalCliCommand === undefined) {
      delete process.env.ORCA_CLI_COMMAND
    } else {
      process.env.ORCA_CLI_COMMAND = originalCliCommand
    }
  })

  const invokeWorkerStart = (flags: Map<string, string | boolean>, json = true) =>
    ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json
    } as never)

  it('passes the complete supported creation contract and retry receipt', async () => {
    callMock.mockResolvedValue({
      result: {
        runId: 'run_1',
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'ready',
        effects: [],
        residualResources: []
      }
    })

    await invokeWorkerStart(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['on', 'windows'],
        ['worktree', 'new-top-level'],
        ['name', 'release-audit'],
        ['repo', 'id:windows-repo'],
        ['base-branch', 'origin/release'],
        ['display-name', 'Release audit'],
        ['comment', 'Supervised from the Mac Run home'],
        ['setup', 'run'],
        ['agent', 'codex'],
        ['timeout-ms', '90000'],
        ['run', 'run_1'],
        ['from', 'term_coord'],
        ['retry-request', '44444444-4444-4444-8444-444444444444']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.workerStart',
      {
        task: 'task_1',
        on: 'windows',
        worktree: 'new-top-level',
        name: 'release-audit',
        repo: 'id:windows-repo',
        baseBranch: 'origin/release',
        displayName: 'Release audit',
        comment: 'Supervised from the Mac Run home',
        setup: 'run',
        agent: 'codex',
        terminal: undefined,
        retryOf: undefined,
        timeoutMs: 90_000,
        run: 'run_1',
        from: 'term_coord',
        devMode: false
      },
      { orchestrationRequestId: '44444444-4444-4444-8444-444444444444' }
    )
    expect(process.exitCode).toBeUndefined()
  })

  it('capability-gates and forwards per-invocation launch preferences', async () => {
    callMock
      .mockResolvedValueOnce({
        result: {
          capabilities: [ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY]
        }
      })
      .mockResolvedValueOnce({
        result: {
          runId: 'run_1',
          taskId: 'task_1',
          dispatchId: 'ctx_1',
          state: 'ready',
          effects: [],
          residualResources: []
        }
      })

    await invokeWorkerStart(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'claude'],
        ['model', 'aws-bedrock-opus-5'],
        ['effort', 'high'],
        ['from', 'term_coord']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerStart',
      expect.objectContaining({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        effort: 'high'
      })
    )
  })

  it('forwards --spec without a task for atomic creation', async () => {
    callMock.mockResolvedValue({
      result: { runId: 'run_1', taskId: 'task_new', dispatchId: 'ctx_1', state: 'ready' }
    })
    await invokeWorkerStart(
      new Map<string, string | boolean>([
        ['spec', 'Implement atomic start'],
        ['agent', 'codex'],
        ['from', 'term_coord']
      ])
    )
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.workerStart',
      expect.objectContaining({ task: undefined, spec: 'Implement atomic start' })
    )
  })

  it('fails before worker-start when the runtime would strip launch preferences', async () => {
    callMock.mockResolvedValueOnce({ result: { capabilities: [] } })

    await expect(
      invokeWorkerStart(
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['agent', 'codex'],
          ['model', 'gpt-5.6-sol'],
          ['from', 'term_coord']
        ])
      )
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })

    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it('sets an unsuccessful exit code for failed and unknown receipts', async () => {
    callMock.mockResolvedValue({
      result: {
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'outcome_unknown',
        effects: [],
        residualResources: []
      }
    })

    await invokeWorkerStart(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'codex'],
        ['from', 'term_coord']
      ])
    )

    expect(process.exitCode).toBe(1)
  })

  it.each([
    ['JSON', 'orca-dev', true],
    ['plain', 'orca-ide', false]
  ] as const)(
    'renders %s recovery commands through the resolved %s executable',
    async (_format, executable, json) => {
      process.env.ORCA_CLI_COMMAND = executable
      callMock.mockResolvedValue({
        result: {
          taskId: 'task_1',
          dispatchId: 'ctx_unknown',
          state: 'outcome_unknown',
          effects: [],
          residualResources: [],
          nextCommands: [
            'orca orchestration worker-show --dispatch ctx_unknown --json',
            'orca orchestration worker-abandon --dispatch ctx_unknown --json'
          ]
        }
      })

      await invokeWorkerStart(
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['agent', 'codex'],
          ['from', 'term_coord']
        ]),
        json
      )

      const [response, , formatter] = vi.mocked(printResult).mock.calls[0] as [
        { result: RecoveryWorkerStartResult },
        boolean,
        (result: RecoveryWorkerStartResult) => string
      ]
      expect(response.result.nextCommands).toEqual([
        `${executable} orchestration worker-show --dispatch ctx_unknown --json`,
        `${executable} orchestration worker-abandon --dispatch ctx_unknown --json`
      ])
      if (!json) {
        expect(formatter(response.result)).toContain(
          `Next command: ${executable} orchestration worker-show --dispatch ctx_unknown --json`
        )
      }
    }
  )

  it('prints the Structured Chat recovery action for a refused worker start', async () => {
    callMock.mockResolvedValue({
      result: {
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'failed',
        failedStage: 'dispatch_input',
        lastError:
          'The target terminal is in Structured Chat. Switch it to Terminal, then retry `orca orchestration worker-start`.',
        effects: [],
        residualResources: []
      }
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags: new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['terminal', 'term_worker'],
        ['from', 'term_coord']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: {
          taskId: string
          dispatchId: string
          state: string
          failedStage?: string
          lastError?: string
        }) => string)
      | undefined
    expect(
      formatter?.({
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'failed',
        failedStage: 'dispatch_input',
        lastError:
          'The target terminal is in Structured Chat. Switch it to Terminal, then retry `orca orchestration worker-start`.'
      })
    ).toMatch(/Structured Chat.*Switch it to Terminal.*orca orchestration worker-start/s)
  })

  it('prints a reveal warning for a live background worker', async () => {
    callMock.mockResolvedValue({
      result: {
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'ready',
        warning: 'Terminal term_worker is running but could not be revealed.',
        effects: [],
        residualResources: []
      }
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags: new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'codex'],
        ['from', 'term_coord']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: {
          taskId: string
          dispatchId: string
          state: string
          warning?: string
        }) => string)
      | undefined
    expect(
      formatter?.({
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'ready',
        warning: 'Terminal term_worker is running but could not be revealed.'
      })
    ).toContain('Warning: Terminal term_worker is running but could not be revealed.')
  })

  it('prints the retained-process warning for a manual worker-stop', async () => {
    callMock.mockResolvedValue({
      result: {
        dispatchId: 'ctx_manual',
        state: 'stopped',
        processAction: 'none',
        warning: 'The assignment was stopped without closing its unsupervised terminal process.'
      }
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-stop']({
      flags: new Map<string, string | boolean>([['dispatch', 'ctx_manual']]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: {
          dispatchId: string
          state: string
          processAction: string
          warning?: string
        }) => string)
      | undefined
    expect(
      formatter?.({
        dispatchId: 'ctx_manual',
        state: 'stopped',
        processAction: 'none',
        warning: 'The assignment was stopped without closing its unsupervised terminal process.'
      })
    ).toContain(
      'Warning: The assignment was stopped without closing its unsupervised terminal process.'
    )
  })

  it('allows the initial zero cursor when paging worker output', async () => {
    callMock.mockResolvedValue({
      result: {
        dispatchId: 'ctx_1',
        terminal: { tail: [], status: 'running', nextCursor: '0' }
      }
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-read']({
      flags: new Map<string, string | boolean>([
        ['dispatch', 'ctx_1'],
        ['cursor', '0'],
        ['limit', '100']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.workerRead', {
      dispatch: 'ctx_1',
      cursor: 0,
      limit: 100,
      source: undefined
    })
  })

  it('passes opaque source-pinned cursors and explicit source selection', async () => {
    callMock.mockResolvedValue({
      result: {
        dispatchId: 'ctx_1',
        source: 'transcript',
        transcript: { messages: [], nextCursor: 'owr1_next' }
      }
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-read']({
      flags: new Map<string, string | boolean>([
        ['dispatch', 'ctx_1'],
        ['cursor', 'owr1_previous'],
        ['source', 'transcript']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.workerRead', {
      dispatch: 'ctx_1',
      cursor: 'owr1_previous',
      limit: undefined,
      source: 'transcript'
    })
  })

  it('formats a legacy worker-list response without projection or page fields', async () => {
    callMock.mockResolvedValue({
      result: {
        workers: [
          {
            dispatchId: 'ctx_legacy',
            taskId: 'task_legacy',
            runId: 'run_legacy',
            workerState: 'ready',
            dispatchStatus: 'dispatched',
            agentTerminalHandle: 'term_legacy',
            terminalState: 'active',
            resource: null
          }
        ],
        counts: { active: 1 }
      }
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map(),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: { workers: unknown[]; counts: Record<string, number> }) => string)
      | undefined
    expect(
      formatter?.({
        workers: [
          {
            dispatchId: 'ctx_legacy',
            taskId: 'task_legacy',
            runId: 'run_legacy',
            workerState: 'ready',
            dispatchStatus: 'dispatched',
            agentTerminalHandle: 'term_legacy',
            terminalState: 'active',
            resource: null
          }
        ],
        counts: { active: 1 }
      })
    ).toContain('ctx_legacy task=task_legacy [ready] terminal=active')
  })

  it.each([
    ['--include-remote', new Map<string, string | boolean>([['include-remote', true]])],
    ['--limit', new Map<string, string | boolean>([['limit', '10']])],
    ['--cursor', new Map<string, string | boolean>([['cursor', 'legacy_cursor']])]
  ])('fails closed when an older runtime strips explicit %s semantics', async (_flag, flags) => {
    callMock.mockResolvedValue({ result: { workers: [], counts: {} } })

    await expect(
      ORCHESTRATION_HANDLERS['orchestration worker-list']({
        flags,
        client: { call: callMock },
        cwd: '/tmp/repo',
        json: true
      } as never)
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })

    // The extra call is the bound-Run lookup; the enumeration itself must not be retried.
    expect(
      callMock.mock.calls.filter(([method]) => method === 'orchestration.workerList')
    ).toHaveLength(1)
    expect(printResult).not.toHaveBeenCalled()
  })

  it('prints each projected row with its literal next-action argv', async () => {
    const response = {
      result: {
        workers: [
          {
            dispatchId: 'ctx_live',
            taskId: 'task_live',
            runId: 'run_1',
            workerState: 'running',
            dispatchStatus: 'dispatched',
            agentTerminalHandle: 'term_live',
            terminalState: 'active',
            resource: null,
            projection: {
              provider: { id: 'claude', model: 'opus' },
              host: { id: 'local' },
              workspace: { id: 'ws_1' },
              stage: { activity: 'working' },
              liveness: { verdict: 'live' },
              nextAction: {
                argv: ['orchestration', 'worker-release', '--dispatch', 'ctx_live']
              },
              attention: { categories: ['settled'] }
            }
          },
          {
            dispatchId: 'ctx_done',
            taskId: 'task_done',
            runId: 'run_1',
            workerState: 'released',
            dispatchStatus: 'completed',
            agentTerminalHandle: null,
            terminalState: null,
            resource: null,
            projection: {
              provider: null,
              host: { id: 'local' },
              workspace: null,
              stage: { activity: 'released' },
              liveness: { verdict: 'exited' },
              nextAction: { argv: [] },
              attention: { categories: [] }
            }
          }
        ],
        counts: { active: 1 },
        page: { total: 2, hasMore: false, nextCursor: null }
      }
    }
    callMock.mockResolvedValue(response)

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>(),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: (typeof response)['result']) => string)
      | undefined
    const output = formatter?.(response.result)
    expect(output).toContain(
      'ctx_live task=task_live [running/working] attention=settled liveness=live provider=claude/opus host=local workspace=ws_1 terminal=active next=orchestration worker-release --dispatch ctx_live'
    )
    expect(output).toContain(
      'ctx_done task=task_done [released/released] attention=none liveness=exited provider=unknown host=local workspace=unknown terminal=none next=none'
    )
  })

  it('prints partial host warnings alongside worker rows', async () => {
    const response = {
      result: {
        workers: [
          {
            dispatchId: 'ctx_remote',
            taskId: 'task_remote',
            runId: 'run_1',
            workerState: 'running',
            dispatchStatus: 'dispatched',
            agentTerminalHandle: 'term_remote',
            terminalState: 'active',
            resource: null
          }
        ],
        counts: { active: 1 },
        page: { total: 1, hasMore: false, nextCursor: null },
        partialHostErrors: [
          {
            environmentId: 'environment_windows',
            name: 'Windows host',
            code: 'host_unavailable',
            dispatchIds: ['ctx_remote']
          }
        ]
      }
    }
    callMock.mockResolvedValue(response)

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([['include-remote', true]]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: (typeof response)['result']) => string)
      | undefined
    const output = formatter?.(response.result)
    expect(output).toContain('ctx_remote task=task_remote [running] terminal=active')
    expect(output).toContain(
      'Warning: worker observations from Windows host (environment_windows) are incomplete: host_unavailable; dispatches=ctx_remote'
    )
  })

  it('prints partial host warnings when no worker rows are available', async () => {
    const response = {
      result: {
        workers: [],
        counts: {},
        page: { total: 0, hasMore: false, nextCursor: null },
        partialHostErrors: [
          {
            environmentId: 'environment_linux',
            name: 'Linux host',
            code: 'capability_unsupported',
            dispatchIds: []
          }
        ]
      }
    }
    callMock.mockResolvedValue(response)

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([['include-remote', true]]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: (typeof response)['result']) => string)
      | undefined
    expect(formatter?.(response.result)).toBe(
      'No workers found.\nScope: all Runs (no Run is bound to this terminal; pass --run to narrow)' +
        '\nWarning: worker observations from Linux host (environment_linux) are incomplete: capability_unsupported; dispatches=none'
    )
  })

  it('preserves partial host errors in JSON output', async () => {
    const response = {
      result: {
        workers: [],
        counts: {},
        page: { total: 0, hasMore: false, nextCursor: null },
        partialHostErrors: [
          {
            environmentId: 'environment_windows',
            name: 'Windows host',
            code: 'host_unavailable',
            dispatchIds: ['ctx_remote']
          }
        ]
      }
    }
    callMock.mockResolvedValue(response)

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([['include-remote', true]]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(printResult).toHaveBeenCalledWith(
      { ...response, result: { ...response.result, scope: { source: 'all' } } },
      true,
      expect.any(Function)
    )
  })

  it('parses, forwards, and documents the remote fleet opt-in', async () => {
    const listSpec = ORCHESTRATION_WORKER_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'orchestration worker-list'
    )
    expect(BOOLEAN_FLAGS).toContain('include-remote')
    expect(
      parseArgs(['orchestration', 'worker-list', '--include-remote']).flags.get('include-remote')
    ).toBe(true)
    expect(listSpec?.allowedFlags).toContain('include-remote')
    expect(formatCommandHelp(listSpec!)).toContain(
      '--include-remote      Include connected-server worker observations'
    )

    callMock.mockResolvedValue({
      result: {
        workers: [],
        counts: {},
        page: { total: 0, hasMore: false, nextCursor: null }
      }
    })
    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([['include-remote', true]]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.workerList',
      expect.objectContaining({ includeRemote: true, paginate: true })
    )

    callMock.mockClear()
    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map(),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    const listParams = callMock.mock.calls.find(
      ([method]) => method === 'orchestration.workerList'
    )?.[1]
    expect(listParams).toHaveProperty('paginate', true)
    expect(listParams).not.toHaveProperty('includeRemote')
  })

  it('keeps cleanup and retention TTL controls off the public CLI surface', async () => {
    const retainSpec = ORCHESTRATION_WORKER_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'orchestration worker-retain'
    )
    expect(
      ORCHESTRATION_WORKER_COMMAND_SPECS.some(
        (spec) => spec.path.join(' ') === 'orchestration worker-cleanup'
      )
    ).toBe(false)
    expect(retainSpec?.allowedFlags).not.toContain('until')
    expect(retainSpec?.allowedFlags).not.toContain('policy')
    expect(ORCHESTRATION_HANDLERS['orchestration worker-cleanup']).toBeUndefined()

    callMock.mockResolvedValue({
      result: { dispatchId: 'ctx_1', state: 'retained', processAction: 'none' }
    })
    await ORCHESTRATION_HANDLERS['orchestration worker-retain']({
      flags: new Map<string, string | boolean>([['dispatch', 'ctx_1']]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    expect(callMock).toHaveBeenCalledWith('orchestration.workerRetain', { dispatch: 'ctx_1' })
  })
})
