import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

describe('orchestration worker-start CLI contract', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = originalExitCode
  })

  const invokeWorkerStart = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
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
        ['retry-request', 'request_1']
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
      { orchestrationRequestId: 'request_1' }
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

  it('renders heartbeat freshness only when the host reports it', async () => {
    callMock.mockResolvedValue({ workers: [], counts: {} })

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>(),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: {
          workers: {
            dispatchId: string
            taskId: string
            workerState: string
            terminalState: string | null
            lastHeartbeatReceivedAt?: string | null
            heartbeatAgeSeconds?: number | null
            heartbeatState?: 'never' | 'recorded' | 'unreadable'
          }[]
          counts: Record<string, number>
        }) => string)
      | undefined

    expect(
      formatter?.({
        workers: [
          {
            dispatchId: 'ctx_fresh',
            taskId: 'task_1',
            workerState: 'ready',
            terminalState: 'active',
            lastHeartbeatReceivedAt: '2026-08-22T10:00:00Z',
            heartbeatAgeSeconds: 42,
            heartbeatState: 'recorded'
          },
          {
            dispatchId: 'ctx_silent',
            taskId: 'task_2',
            workerState: 'ready',
            terminalState: 'active',
            lastHeartbeatReceivedAt: null,
            heartbeatAgeSeconds: null,
            heartbeatState: 'never'
          },
          // A stored stamp with no derivable age must not read as "never reported".
          {
            dispatchId: 'ctx_corrupt',
            taskId: 'task_3',
            workerState: 'ready',
            terminalState: 'active',
            lastHeartbeatReceivedAt: 'not-a-timestamp',
            heartbeatAgeSeconds: null,
            heartbeatState: 'unreadable'
          },
          // A host contradicting itself — 'recorded' with no number — is unknown, never fabricated.
          {
            dispatchId: 'ctx_contradictory',
            taskId: 'task_4',
            workerState: 'ready',
            terminalState: 'active',
            lastHeartbeatReceivedAt: '2026-08-22T10:00:00Z',
            heartbeatAgeSeconds: null,
            heartbeatState: 'recorded'
          },
          // An old host omits every field; the row must not claim the worker went silent.
          {
            dispatchId: 'ctx_old_host',
            taskId: 'task_5',
            workerState: 'ready',
            terminalState: 'active'
          }
        ],
        counts: {}
      })
    ).toBe(
      [
        'ctx_fresh task=task_1 [ready] terminal=active heartbeat=42s',
        'ctx_silent task=task_2 [ready] terminal=active heartbeat=none',
        'ctx_corrupt task=task_3 [ready] terminal=active heartbeat=unknown',
        'ctx_contradictory task=task_4 [ready] terminal=active heartbeat=unknown',
        'ctx_old_host task=task_5 [ready] terminal=active'
      ].join('\n')
    )
  })
})
