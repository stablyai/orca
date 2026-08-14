import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { quotaScenarioMock } from './orchestration-worker-supervise-test-mocks'

describe('orchestration worker-supervise CLI contract', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = originalExitCode
  })

  it('switches #3 to #2 only after exact quota evidence and stops at worker_done', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let startCount = 0
    let activeAccountId = 'account-3'
    callMock.mockImplementation(
      (method: string, params: { dispatch?: string; accountId?: string }) => {
        if (method === 'status.get') {
          return Promise.resolve({
            result: { capabilities: [ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY] }
          })
        }
        if (method === 'accounts.list') {
          return Promise.resolve({
            result: {
              codex: {
                accounts: [
                  {
                    id: 'account-3',
                    email: 'three@example.com',
                    workspaceLabel: 'Codex #3｜F Team'
                  },
                  {
                    id: 'account-2',
                    email: 'two@example.com',
                    workspaceLabel: 'Codex #2｜H Team'
                  }
                ],
                activeAccountId
              }
            }
          })
        }
        if (method === 'accounts.selectCodex') {
          activeAccountId = params.accountId ?? activeAccountId
          return Promise.resolve({ result: { accounts: [], activeAccountId } })
        }
        if (method === 'orchestration.workerStart') {
          startCount += 1
          return Promise.resolve({
            result: {
              runId: 'run-1',
              taskId: 'task-1',
              dispatchId: startCount === 1 ? 'dispatch-3' : 'dispatch-2',
              state: 'ready'
            }
          })
        }
        if (method === 'orchestration.workerRead') {
          const quota = params.dispatch === 'dispatch-3'
          return Promise.resolve({
            result: {
              dispatchId: params.dispatch,
              source: 'transcript',
              transcript: {
                messages: quota
                  ? [
                      {
                        role: 'system',
                        blocks: [
                          {
                            type: 'text',
                            text: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 11:32 AM."
                          }
                        ]
                      }
                    ]
                  : [],
                nextCursor: null
              }
            }
          })
        }
        if (method === 'orchestration.check') {
          return Promise.resolve({
            result: {
              messages:
                startCount === 2
                  ? [
                      {
                        id: 'message-done',
                        type: 'worker_done',
                        subject: 'Worker completed',
                        payload: JSON.stringify({
                          taskId: 'task-1',
                          dispatchId: 'dispatch-2',
                          outcome: 'succeeded'
                        })
                      }
                    ]
                  : []
            }
          })
        }
        if (method === 'orchestration.workerShow') {
          return Promise.resolve({
            result: {
              dispatch: {
                id: params.dispatch,
                task_id: 'task-1',
                run_id: 'run-1',
                status: params.dispatch === 'dispatch-2' ? 'completed' : 'dispatched'
              },
              worker: {
                state: params.dispatch === 'dispatch-2' ? 'succeeded' : 'active',
                stage: 'running',
                agent_terminal_handle: 'term-worker'
              }
            }
          })
        }
        if (method === 'orchestration.workerStop') {
          return Promise.resolve({ result: { state: 'stopped' } })
        }
        if (method === 'orchestration.workerRelease') {
          return Promise.resolve({ result: { state: 'released' } })
        }
        throw new Error(`Unexpected method ${method}`)
      }
    )

    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3,#2'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('accounts.selectCodex', { accountId: 'account-3' })
    expect(callMock).toHaveBeenCalledWith('accounts.selectCodex', { accountId: 'account-2' })
    const starts = callMock.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    expect(starts).toHaveLength(2)
    expect(starts[1]?.[1]).toEqual(expect.objectContaining({ retryOf: 'dispatch-3' }))
    expect(callMock).toHaveBeenCalledWith('orchestration.workerStop', {
      dispatch: 'dispatch-3'
    })
    expect(callMock).toHaveBeenCalledWith('orchestration.workerRelease', {
      dispatch: 'dispatch-3'
    })
    // 佐證 should-fix：check 走 all 模式，已讀的 worker_done 也看得到、且不消費信箱。
    const checkCall = callMock.mock.calls.find(([method]) => method === 'orchestration.check')
    expect(checkCall?.[1]).toEqual(expect.objectContaining({ all: true }))
    expect(checkCall?.[1]).not.toHaveProperty('peek')
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"state": "awaiting_acceptance"'))
    // 信封 ok 跟隨結束碼：成功收在 ok:true。
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"ok": true'))
    // 每個 attempt 都要留下可精確恢復的 startRequestId。
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"startRequestId"'))
    expect(process.exitCode).toBeUndefined()
    logSpy.mockRestore()
  })

  it('does not select or start another account after the supervision deadline', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(2)
    callMock.mockImplementation((method: string, params: { dispatch?: string }) => {
      if (method === 'status.get') {
        return Promise.resolve({
          result: { capabilities: [ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY] }
        })
      }
      if (method === 'accounts.list') {
        return Promise.resolve({
          result: {
            codex: {
              accounts: [
                { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' },
                { id: 'account-2', email: 'two@example.com', workspaceLabel: 'Codex #2' }
              ],
              activeAccountId: 'account-3'
            }
          }
        })
      }
      if (method === 'accounts.selectCodex') {
        return Promise.resolve({ result: { accounts: [], activeAccountId: 'account-3' } })
      }
      if (method === 'orchestration.workerStart') {
        return Promise.resolve({
          result: {
            runId: 'run-1',
            taskId: 'task-1',
            dispatchId: 'dispatch-3',
            state: 'ready'
          }
        })
      }
      if (method === 'orchestration.workerRead') {
        return Promise.resolve({
          result: {
            dispatchId: params.dispatch,
            source: 'transcript',
            transcript: {
              messages: [
                { role: 'system', blocks: [{ type: 'text', text: 'Usage limit reached.' }] }
              ],
              nextCursor: null
            }
          }
        })
      }
      if (method === 'orchestration.check') {
        return Promise.resolve({ result: { messages: [] } })
      }
      if (method === 'orchestration.workerShow') {
        return Promise.resolve({
          result: { dispatch: { status: 'dispatched' }, worker: { state: 'active' } }
        })
      }
      if (method === 'orchestration.workerStop') {
        return Promise.resolve({ result: { state: 'stopped' } })
      }
      if (method === 'orchestration.workerRelease') {
        return Promise.resolve({ result: { state: 'released' } })
      }
      throw new Error(`Unexpected method ${method}`)
    })

    try {
      await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
        flags: new Map([
          ['task', 'task-1'],
          ['accounts', '#3,#2'],
          ['wait-timeout-ms', '1'],
          ['from', 'term-coordinator']
        ]),
        client: { call: callMock },
        cwd: '/tmp/repo',
        json: true
      } as never)

      expect(
        callMock.mock.calls.filter(([method]) => method === 'accounts.selectCodex')
      ).toHaveLength(1)
      expect(
        callMock.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
      ).toHaveLength(1)
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('timed_out_between_attempts'))
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"ok": false'))
      expect(process.exitCode).toBe(1)
    } finally {
      nowSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it('does not switch accounts after a non-quota start failure', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation((method: string) => {
      if (method === 'status.get') {
        return Promise.resolve({
          result: { capabilities: [ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY] }
        })
      }
      if (method === 'accounts.list') {
        return Promise.resolve({
          result: {
            codex: {
              accounts: [
                { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' },
                { id: 'account-2', email: 'two@example.com', workspaceLabel: 'Codex #2' }
              ],
              activeAccountId: 'account-3'
            }
          }
        })
      }
      if (method === 'accounts.selectCodex') {
        return Promise.resolve({ result: { accounts: [], activeAccountId: 'account-3' } })
      }
      if (method === 'orchestration.workerStart') {
        return Promise.resolve({
          result: {
            runId: 'run-1',
            taskId: 'task-1',
            dispatchId: 'dispatch-3',
            state: 'failed',
            lastError: 'Worktree setup failed'
          }
        })
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3,#2'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

    expect(
      callMock.mock.calls.filter(([method]) => method === 'accounts.selectCodex')
    ).toHaveLength(1)
    expect(process.exitCode).toBe(1)
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to start without provider quota evidence')
    )
    logSpy.mockRestore()
  })

  it('rejects remote account failover before reading or changing accounts', async () => {
    await expect(
      ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
        flags: new Map([
          ['task', 'task-1'],
          ['accounts', '#3,#2'],
          ['on', 'windows'],
          ['from', 'term-coordinator']
        ]),
        client: { call: callMock },
        cwd: '/tmp/repo',
        json: true
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_argument' })

    expect(callMock).not.toHaveBeenCalled()
  })

  it('refuses a runtime that would strip managed-account identity', async () => {
    callMock.mockImplementation((method: string) => {
      if (method === 'status.get') {
        return Promise.resolve({ result: { capabilities: [] } })
      }
      if (method === 'accounts.list') {
        return Promise.resolve({
          result: {
            codex: {
              accounts: [
                { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' }
              ],
              activeAccountId: 'account-3'
            }
          }
        })
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await expect(
      ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
        flags: new Map([
          ['task', 'task-1'],
          ['accounts', '#3'],
          ['from', 'term-coordinator']
        ]),
        client: { call: callMock },
        cwd: '/tmp/repo',
        json: true
      } as never)
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })

    expect(
      callMock.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    ).toHaveLength(0)
    expect(
      callMock.mock.calls.filter(([method]) => method === 'accounts.selectCodex')
    ).toHaveLength(0)
  })

  it('runtime 帳號 pin 失敗（含 ABA 情境）＝start 失敗，不切帳、不背書', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation((method: string) => {
      if (method === 'status.get') {
        return Promise.resolve({
          result: { capabilities: [ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY] }
        })
      }
      if (method === 'accounts.list') {
        return Promise.resolve({
          result: {
            codex: {
              accounts: [
                { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' },
                { id: 'account-2', email: 'two@example.com', workspaceLabel: 'Codex #2' }
              ],
              activeAccountId: 'account-3'
            }
          }
        })
      }
      if (method === 'accounts.selectCodex') {
        return Promise.resolve({ result: { accounts: [], activeAccountId: 'account-3' } })
      }
      if (method === 'orchestration.workerStart') {
        // runtime 端 PTY 登錄表 pin 驗證失敗（例如 ABA：實際以 account-2 啟動）。
        return Promise.resolve({
          result: {
            runId: 'run-1',
            taskId: 'task-1',
            dispatchId: 'dispatch-3',
            state: 'failed',
            failedStage: 'account_verification',
            lastError:
              'Worker terminal term-worker launched under Codex account account-2, not the requested managed account account-3.'
          }
        })
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3,#2'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    // 帳號驗證失敗不是額度證據 → 不得切到下一帳號。
    expect(
      callMock.mock.calls.filter(([method]) => method === 'accounts.selectCodex')
    ).toHaveLength(1)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"state": "start_failed"'))
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })

  it('stops supervision when a quota-blocked worker cannot be provably released', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation((method: string, params: { dispatch?: string }) => {
      if (method === 'status.get') {
        return Promise.resolve({
          result: { capabilities: [ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY] }
        })
      }
      if (method === 'accounts.list') {
        return Promise.resolve({
          result: {
            codex: {
              accounts: [
                { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' },
                { id: 'account-2', email: 'two@example.com', workspaceLabel: 'Codex #2' }
              ],
              activeAccountId: 'account-3'
            }
          }
        })
      }
      if (method === 'accounts.selectCodex') {
        return Promise.resolve({ result: { accounts: [], activeAccountId: 'account-3' } })
      }
      if (method === 'orchestration.workerStart') {
        return Promise.resolve({
          result: { runId: 'run-1', taskId: 'task-1', dispatchId: 'dispatch-3', state: 'ready' }
        })
      }
      if (method === 'orchestration.workerRead') {
        return Promise.resolve({
          result: {
            dispatchId: params.dispatch,
            source: 'transcript',
            transcript: {
              messages: [
                { role: 'system', blocks: [{ type: 'text', text: 'Usage limit reached.' }] }
              ],
              nextCursor: null
            }
          }
        })
      }
      if (method === 'orchestration.check') {
        return Promise.resolve({ result: { messages: [] } })
      }
      if (method === 'orchestration.workerShow') {
        return Promise.resolve({
          result: { dispatch: { status: 'dispatched' }, worker: { state: 'active' } }
        })
      }
      if (method === 'orchestration.workerStop') {
        return Promise.resolve({ result: { state: 'stopped' } })
      }
      if (method === 'orchestration.workerRelease') {
        return Promise.resolve({ result: { state: 'release_pending', recovery: 'retry later' } })
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3,#2'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    // 未落定的 release 不得繼續在同一工作樹燒下一個帳號。
    expect(
      callMock.mock.calls.filter(([method]) => method === 'accounts.selectCodex')
    ).toHaveLength(1)
    expect(
      callMock.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    ).toHaveLength(1)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"state": "release_unsettled"'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"ok": false'))
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })

  const runSupervise = () =>
    ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3,#2'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('quota 後 stop_unknown＝無法證明停止，中止監督不燒下一帳號', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation(quotaScenarioMock({ stopState: 'stop_unknown' }))
    await runSupervise()
    expect(
      callMock.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    ).toHaveLength(1)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"state": "stop_unsettled"'))
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })

  it('quota 後 release_unknown＝未落定，中止監督', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation(quotaScenarioMock({ releaseState: 'release_unknown' }))
    await runSupervise()
    expect(
      callMock.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    ).toHaveLength(1)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"state": "release_unsettled"'))
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })

  it('quota 後 already_released 視為已落定，正常遞補到下一帳號', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation(quotaScenarioMock({ releaseState: 'already_released' }))
    await runSupervise()
    expect(
      callMock.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    ).toHaveLength(2)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"state": "awaiting_acceptance"'))
    expect(process.exitCode).toBeUndefined()
    logSpy.mockRestore()
  })

  it('第二帳號 select 讀回不符時，第一個 attempt 證據仍完整輸出', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation(quotaScenarioMock({ selectSecondActive: 'account-3' }))
    await runSupervise()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"state": "account_select_unconfirmed"')
    )
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"dispatchId": "dispatch-3"'))
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })
})
