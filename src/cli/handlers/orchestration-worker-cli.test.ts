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

  it('records coordinator acceptance before releasing and never removes the worktree', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation((method: string) => {
      if (method === 'orchestration.workerShow') {
        return Promise.resolve({
          result: {
            dispatch: {
              id: 'dispatch-2',
              task_id: 'task-1',
              run_id: 'run-1',
              status: 'completed'
            },
            worker: {
              state: 'succeeded',
              stage: 'settled',
              agent_terminal_handle: 'term-worker',
              worktree_id: 'worktree-1',
              startOptions: {
                managedAccount: {
                  provider: 'codex',
                  id: 'account-2',
                  label: 'Codex #2｜H Team'
                }
              }
            }
          }
        })
      }
      if (method === 'git.status') {
        return Promise.resolve({
          result: {
            entries: [],
            conflictOperation: 'unknown',
            didHitLimit: false,
            head: 'abc1234def5678',
            upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
          }
        })
      }
      if (method === 'orchestration.send') {
        return Promise.resolve({ result: { message: { id: 'acceptance-1', run_id: 'run-1' } } })
      }
      if (method === 'orchestration.workerRelease') {
        return Promise.resolve({
          result: {
            dispatchId: 'dispatch-2',
            state: 'released',
            processAction: 'closed',
            archive: { source: 'transcript', status: 'saved' }
          }
        })
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-accept']({
      flags: new Map([
        ['dispatch', 'dispatch-2'],
        ['evidence', 'tests 42/42; review clean'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    const sendIndex = callMock.mock.calls.findIndex(([method]) => method === 'orchestration.send')
    const releaseIndex = callMock.mock.calls.findIndex(
      ([method]) => method === 'orchestration.workerRelease'
    )
    const send = callMock.mock.calls[sendIndex]
    expect(send?.[1]).toEqual(
      expect.objectContaining({
        to: 'dispatch:dispatch-2',
        payload: expect.stringContaining('"accountLabel":"Codex #2｜H Team"')
      })
    )
    expect(send?.[1]).toEqual(
      expect.objectContaining({ payload: expect.stringContaining('"removed":false') })
    )
    // 回執必須記錄被接手的 worktree HEAD SHA。
    expect(send?.[1]).toEqual(
      expect.objectContaining({ payload: expect.stringContaining('"sha":"abc1234def5678"') })
    )
    expect(sendIndex).toBeGreaterThanOrEqual(0)
    expect(sendIndex).toBeLessThan(releaseIndex)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"closeable": true'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"removed": false'))
    logSpy.mockRestore()
  })

  it('release_pending 不得回報 accepted，exit 1 並保留恢復義務', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation((method: string) => {
      if (method === 'orchestration.workerShow') {
        return Promise.resolve({
          result: {
            dispatch: { id: 'dispatch-2', task_id: 'task-1', run_id: 'run-1', status: 'completed' },
            worker: {
              state: 'succeeded',
              stage: 'settled',
              agent_terminal_handle: 'term-worker',
              worktree_id: 'worktree-1'
            }
          }
        })
      }
      if (method === 'git.status') {
        return Promise.resolve({
          result: {
            entries: [],
            conflictOperation: 'unknown',
            didHitLimit: false,
            head: 'abc1234def5678',
            upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
          }
        })
      }
      if (method === 'orchestration.send') {
        return Promise.resolve({ result: { message: { id: 'acceptance-1', run_id: 'run-1' } } })
      }
      if (method === 'orchestration.workerRelease') {
        return Promise.resolve({
          result: {
            dispatchId: 'dispatch-2',
            state: 'release_pending',
            processAction: 'none',
            archive: null,
            recovery: 'orca orchestration worker-release --dispatch dispatch-2 --retry-request <id>'
          }
        })
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-accept']({
      flags: new Map([
        ['dispatch', 'dispatch-2'],
        ['evidence', 'tests pass'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"state": "acceptance_recorded_release_pending"')
    )
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })

  it('首呼即帶確定性 send id；release 未帶旗標時由 client 自產 id', async () => {
    callMock.mockImplementation((method: string) => {
      if (method === 'orchestration.workerShow') {
        return Promise.resolve({
          result: {
            dispatch: { id: 'dispatch-2', task_id: 'task-1', run_id: 'run-1', status: 'completed' },
            worker: { state: 'succeeded', stage: 'settled', agent_terminal_handle: 'term-worker' }
          }
        })
      }
      if (method === 'orchestration.send') {
        return Promise.resolve({ result: { message: { id: 'acceptance-1', run_id: 'run-1' } } })
      }
      if (method === 'orchestration.workerRelease') {
        return Promise.resolve({
          result: {
            dispatchId: 'dispatch-2',
            state: 'released',
            processAction: 'closed',
            archive: null
          }
        })
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-accept']({
      flags: new Map([
        ['dispatch', 'dispatch-2'],
        ['evidence', 'tests pass'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    const send = callMock.mock.calls.find(([method]) => method === 'orchestration.send')
    const release = callMock.mock.calls.find(([method]) => method === 'orchestration.workerRelease')
    // 確定性 id：任何一次執行（首呼或重跑）都命中同一 ledger receipt，不會重寫回執。
    expect(send?.[2]).toEqual({ orchestrationRequestId: 'worker-accept-acceptance-dispatch-2' })
    // 未帶旗標＝首呼；client 對 mutation 自產隨機 id，handler 不傳第三參數。
    expect(release?.[2]).toBeUndefined()
  })

  it('release recovery：send 以確定性 id 冪等重放、release 用回報的原 id', async () => {
    callMock.mockImplementation((method: string) => {
      if (method === 'orchestration.workerShow') {
        return Promise.resolve({
          result: {
            dispatch: { id: 'dispatch-2', task_id: 'task-1', run_id: 'run-1', status: 'completed' },
            worker: { state: 'succeeded', stage: 'settled', agent_terminal_handle: 'term-worker' }
          }
        })
      }
      if (method === 'orchestration.send') {
        return Promise.resolve({ result: { message: { id: 'acceptance-1', run_id: 'run-1' } } })
      }
      if (method === 'orchestration.workerRelease') {
        return Promise.resolve({
          result: {
            dispatchId: 'dispatch-2',
            state: 'released',
            processAction: 'closed',
            archive: null
          }
        })
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-accept']({
      flags: new Map([
        ['dispatch', 'dispatch-2'],
        ['evidence', 'tests pass'],
        ['from', 'term-coordinator'],
        ['retry-release-request', 'release-id-1']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    const send = callMock.mock.calls.find(([method]) => method === 'orchestration.send')
    expect(send?.[2]).toEqual({ orchestrationRequestId: 'worker-accept-acceptance-dispatch-2' })
    const release = callMock.mock.calls.find(([method]) => method === 'orchestration.workerRelease')
    expect(release?.[2]).toEqual({ orchestrationRequestId: 'release-id-1' })
  })

  it('legacy --retry-request 等同 release id；send 照常以確定性 id 執行', async () => {
    callMock.mockImplementation((method: string) => {
      if (method === 'orchestration.workerShow') {
        return Promise.resolve({
          result: {
            dispatch: { id: 'dispatch-2', task_id: 'task-1', run_id: 'run-1', status: 'completed' },
            worker: { state: 'succeeded', stage: 'settled', agent_terminal_handle: 'term-worker' }
          }
        })
      }
      if (method === 'orchestration.send') {
        return Promise.resolve({ result: { message: { id: 'acceptance-1', run_id: 'run-1' } } })
      }
      if (method === 'orchestration.workerRelease') {
        return Promise.resolve({
          result: {
            dispatchId: 'dispatch-2',
            state: 'released',
            processAction: 'closed',
            archive: null
          }
        })
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-accept']({
      flags: new Map([
        ['dispatch', 'dispatch-2'],
        ['evidence', 'tests pass'],
        ['from', 'term-coordinator'],
        ['retry-request', 'legacy-release-id']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    const send = callMock.mock.calls.find(([method]) => method === 'orchestration.send')
    expect(send?.[2]).toEqual({ orchestrationRequestId: 'worker-accept-acceptance-dispatch-2' })
    const release = callMock.mock.calls.find(([method]) => method === 'orchestration.workerRelease')
    expect(release?.[2]).toEqual({ orchestrationRequestId: 'legacy-release-id' })
  })

  it('獨立 worker-release：release_pending 也 exit 1（恢復義務未了）', async () => {
    callMock.mockResolvedValue({
      result: {
        dispatchId: 'ctx_1',
        state: 'release_pending',
        processAction: 'none',
        archive: null,
        recovery: 'retry with --retry-request'
      }
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-release']({
      flags: new Map<string, string | boolean>([['dispatch', 'ctx_1']]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(process.exitCode).toBe(1)
  })
})
