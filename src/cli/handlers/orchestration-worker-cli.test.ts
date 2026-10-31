import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode
vi.mock('../format', async (importOriginal) => {
  const original = await importOriginal<{ printResult: typeof printResult }>()
  return { printResult: vi.fn(original.printResult) }
})
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { parseArgs, validateCommandAndFlags } from '../args'
import { formatCommandHelp } from '../help'
import { buildAgentContext } from '../agent-context'
import { suggestCommands } from '../command-suggestion'
import { okFixture } from '../test-fixtures'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from '../specs/orchestration-worker-specs'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

const client = new RuntimeClient('/tmp/orca-worker-cli', 60_000, null, null)

describe('orchestration worker-start CLI contract', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.spyOn(client, 'call').mockImplementation(callMock)
    vi.mocked(printResult).mockClear()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    process.exitCode = undefined
    vi.stubEnv('ORCA_CLI_COMMAND', undefined)
    vi.stubEnv('ORCA_DEV_CLI_INVOCATION', undefined)
    vi.stubEnv('ORCA_USER_DATA_PATH', undefined)
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_coord')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const invokeWorkerStart = (flags: Map<string, string | boolean>, json = true) =>
    ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags,
      client,
      cwd: '/tmp/repo',
      json
    })

  function printedText(): string {
    expect(console.log).toHaveBeenCalledOnce()
    const output = vi.mocked(console.log).mock.calls[0]?.[0]
    if (typeof output !== 'string') {
      throw new Error('worker command did not print text')
    }
    return output
  }

  function mockWorkerListResponse(response: unknown): void {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'orchestration.runCurrent') {
        return okFixture('req_current', { run: null })
      }
      if (method === 'orchestration.workerList') {
        return response
      }
      throw new Error(`Unexpected worker-list RPC: ${method}`)
    })
  }

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

  it('sets an unsuccessful exit code for an unknown receipt', async () => {
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
          ['full', true],
          ['task', 'task_1'],
          ['agent', 'codex'],
          ['from', 'term_coord']
        ]),
        json
      )

      expect(printResult).toHaveBeenCalledOnce()
      const response = vi.mocked(printResult).mock.calls[0]?.[0]
      expect(response).toHaveProperty('result.nextCommands', [
        `${executable} orchestration worker-show --dispatch ctx_unknown --json`,
        `${executable} orchestration worker-abandon --dispatch ctx_unknown --json`
      ])
      const output = printedText()
      if (!json) {
        expect(output).toContain(
          `Next command: ${executable} orchestration worker-show --dispatch ctx_unknown --json`
        )
      }
    }
  )

  it('prints the host error for a refused worker start', async () => {
    callMock.mockResolvedValue({
      result: {
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'failed',
        failedStage: 'dispatch_input',
        lastError: 'terminal_not_writable',
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
      client,
      cwd: '/tmp/repo',
      json: false
    })

    expect(printedText()).toContain('terminal_not_writable')
    expect(process.exitCode).toBe(1)
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
      client,
      cwd: '/tmp/repo',
      json: false
    })

    expect(printedText()).toContain(
      'warning="Terminal term_worker is running but could not be revealed."'
    )
  })

  it('states the worker mode that actually ran, so a fallback is never silent', async () => {
    callMock.mockResolvedValue({
      result: {
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'ready',
        mode: {
          mode: 'terminal',
          preferred: 'structured',
          reason: 'reused_terminal',
          detail:
            'Your default is a structured chat session, but --terminal reuses a running terminal agent; started a terminal agent worker instead.'
        },
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
      client,
      cwd: '/tmp/repo',
      json: false
    })

    expect(printedText()).toContain('but --terminal reuses a running terminal agent')
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
      client,
      cwd: '/tmp/repo',
      json: false
    })

    expect(printedText()).toContain(
      'warning="The assignment was stopped without closing its unsupervised terminal process."'
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
      client,
      cwd: '/tmp/repo',
      json: true
    })

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
      client,
      cwd: '/tmp/repo',
      json: true
    })

    expect(callMock).toHaveBeenCalledWith('orchestration.workerRead', {
      dispatch: 'ctx_1',
      cursor: 'owr1_previous',
      limit: undefined,
      source: 'transcript'
    })
  })

  it('formats a legacy worker-list response without projection or page fields', async () => {
    mockWorkerListResponse({
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
      flags: new Map([['full', true]]),
      client,
      cwd: '/tmp/repo',
      json: false
    })

    expect(printedText()).toContain('ctx_legacy task=task_legacy [ready] terminal=active')
  })

  it('passes a truncation warning to the receipt and still prints the cursor hint', async () => {
    const response = {
      result: {
        workers: [],
        counts: { active: 1 },
        page: { total: 105, hasMore: true, nextCursor: 'owlc_next' },
        warnings: ['Showing 100 of 105 Dispatches, newest first; more are on later pages.']
      }
    }
    mockWorkerListResponse(response)

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([['full', true]]),
      client,
      cwd: '/tmp/repo',
      json: false
    })

    expect(vi.mocked(printResult).mock.calls[0]?.[0]).toMatchObject({
      result: { warnings: response.result.warnings }
    })
    const output = printedText()
    expect(output).toContain('More: --cursor owlc_next')
    expect(output).toContain(
      'Warning: Showing 100 of 105 Dispatches, newest first; more are on later pages.'
    )
  })

  it.each([
    ['--include-remote', new Map<string, string | boolean>([['include-remote', true]])],
    ['--limit', new Map<string, string | boolean>([['limit', '10']])],
    ['--cursor', new Map<string, string | boolean>([['cursor', 'legacy_cursor']])]
  ])('fails closed when an older runtime strips explicit %s semantics', async (_flag, flags) => {
    mockWorkerListResponse({ result: { workers: [], counts: {} } })

    await expect(
      ORCHESTRATION_HANDLERS['orchestration worker-list']({
        flags,
        client,
        cwd: '/tmp/repo',
        json: true
      })
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })

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
    mockWorkerListResponse(response)

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([['full', true]]),
      client,
      cwd: '/tmp/repo',
      json: false
    })

    const output = printedText()
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
    mockWorkerListResponse(response)

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([
        ['include-remote', true],
        ['full', true]
      ]),
      client,
      cwd: '/tmp/repo',
      json: false
    })

    const output = printedText()
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
    mockWorkerListResponse(response)

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([
        ['include-remote', true],
        ['full', true]
      ]),
      client,
      cwd: '/tmp/repo',
      json: false
    })

    expect(printedText()).toBe(
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
    mockWorkerListResponse(response)

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([
        ['include-remote', true],
        ['full', true]
      ]),
      client,
      cwd: '/tmp/repo',
      json: true
    })

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
    const parsed = parseArgs(['orchestration', 'worker-list', '--include-remote'])
    expect(parsed.flags.get('include-remote')).toBe(true)
    expect(() => validateCommandAndFlags(ORCHESTRATION_WORKER_COMMAND_SPECS, parsed)).not.toThrow()
    if (!listSpec) {
      throw new Error('worker-list command is missing')
    }
    expect(formatCommandHelp(listSpec)).toContain(
      '--include-remote      Include connected-server worker observations'
    )

    mockWorkerListResponse({
      result: {
        workers: [],
        counts: {},
        page: { total: 0, hasMore: false, nextCursor: null }
      }
    })
    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: parsed.flags,
      client,
      cwd: '/tmp/repo',
      json: true
    })
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.workerList',
      expect.objectContaining({ includeRemote: true, paginate: true })
    )

    callMock.mockClear()
    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map(),
      client,
      cwd: '/tmp/repo',
      json: true
    })
    const listParams = callMock.mock.calls.find(
      ([method]) => method === 'orchestration.workerList'
    )?.[1]
    expect(listParams).toHaveProperty('paginate', true)
    expect(listParams).not.toHaveProperty('includeRemote')
  })

  it('keeps cleanup and retention TTL controls off the public CLI surface', async () => {
    const kept = parseArgs(['orchestration', 'worker-keep-open', '--dispatch', 'ctx_1'])
    expect(() => validateCommandAndFlags(ORCHESTRATION_WORKER_COMMAND_SPECS, kept)).not.toThrow()
    expect(() =>
      validateCommandAndFlags(
        ORCHESTRATION_WORKER_COMMAND_SPECS,
        parseArgs(['orchestration', 'worker-cleanup'])
      )
    ).toThrow('Unknown command: orchestration worker-cleanup')
    expect(() =>
      validateCommandAndFlags(
        ORCHESTRATION_WORKER_COMMAND_SPECS,
        parseArgs(['orchestration', 'worker-keep-open', '--until', '2099-01-01T00:00:00Z'])
      )
    ).toThrow('Unknown flag --until for command: orchestration worker-keep-open')

    callMock.mockResolvedValue({
      result: { dispatchId: 'ctx_1', state: 'retained', processAction: 'none' }
    })
    await ORCHESTRATION_HANDLERS['orchestration worker-keep-open']({
      flags: kept.flags,
      client,
      cwd: '/tmp/repo',
      json: true
    })
    expect(callMock).toHaveBeenCalledWith('orchestration.workerRetain', { dispatch: 'ctx_1' })
  })

  it('still runs worker-retain without listing or suggesting it', () => {
    const parsed = parseArgs(['orchestration', 'worker-retain', '--dispatch', 'ctx_1'])
    expect(() => validateCommandAndFlags(ORCHESTRATION_WORKER_COMMAND_SPECS, parsed)).not.toThrow()
    expect(ORCHESTRATION_HANDLERS['orchestration worker-retain']).toBe(
      ORCHESTRATION_HANDLERS['orchestration worker-keep-open']
    )
    const listed = buildAgentContext(ORCHESTRATION_WORKER_COMMAND_SPECS).commands
    expect(JSON.stringify(listed)).not.toContain('worker-retain')
    expect(
      suggestCommands(ORCHESTRATION_WORKER_COMMAND_SPECS, ['orchestration', 'worker-retai'])
    ).not.toContain('orchestration worker-retain')
  })

  it('keeps a worker started with --keep-open open after it finishes', async () => {
    callMock.mockImplementation(async (method: string) =>
      method === 'orchestration.workerStart'
        ? { result: { taskId: 'task_1', dispatchId: 'ctx_1', state: 'ready', effects: [] } }
        : { result: { dispatchId: 'ctx_1', state: 'retained', processAction: 'none' } }
    )
    await invokeWorkerStart(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'codex'],
        ['keep-open', true]
      ]),
      false
    )
    expect(callMock).toHaveBeenLastCalledWith('orchestration.workerRetain', { dispatch: 'ctx_1' })
    expect(printedText()).toContain('keptOpen=true')
  })

  it.each([
    [
      'released',
      { result: { dispatchId: 'ctx_1', state: 'already_released', processAction: 'none' } },
      'worker-read'
    ],
    [
      'no owned terminal',
      {
        result: {
          dispatchId: 'ctx_1',
          state: 'retained',
          reason: 'no_owned_resource',
          processAction: 'none'
        }
      },
      'worker-show'
    ],
    ['error', new RuntimeClientError('runtime_unavailable', 'gone'), 'worker-keep-open']
  ])(
    'prints the start receipt then fails a --keep-open that was not kept (%s)',
    async (_, retain, verb) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      callMock.mockImplementation(async (method: string) => {
        if (method === 'orchestration.workerStart') {
          return { result: { taskId: 'task_1', dispatchId: 'ctx_1', state: 'ready', effects: [] } }
        }
        if (method === 'orchestration.workerRetain' && retain instanceof Error) {
          throw retain
        }
        return retain
      })
      await invokeWorkerStart(
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['agent', 'codex'],
          ['keep-open', true]
        ]),
        false
      )
      const text = printedText()
      expect(text).toContain('dispatchId=ctx_1')
      expect(text).not.toContain('keptOpen')
      const error = String(vi.mocked(console.error).mock.calls[0]?.[0])
      expect(error).toContain('not_kept_open')
      expect(error).toContain(`${verb} --dispatch ctx_1`)
      expect(process.exitCode).toBe(1)
    }
  )

  it('does not tell a coordinator that chat workers skip automatic release', () => {
    const spec = ORCHESTRATION_WORKER_COMMAND_SPECS.find(
      (entry) => entry.path.join(' ') === 'orchestration worker-release'
    )
    if (!spec) {
      throw new Error('worker-release command is missing')
    }
    expect(formatCommandHelp(spec)).not.toContain('never released automatically')
  })
})
