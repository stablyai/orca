import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'
import {
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { quotaScenarioMock } from './orchestration-worker-supervise-test-mocks'

// worker-supervise 的 lost-reply／精確重放（recovery）契約測試。
describe('orchestration worker-supervise recovery contract', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = originalExitCode
  })

  it('start 回覆遺失＝attempt 連同 startRequestId 留存，指引精確重放', async () => {
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
                { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' }
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
        // production transport 型別：timeout＝結果未知，必須給 recovery 指令。
        return Promise.reject(
          new RuntimeClientError(
            'runtime_timeout',
            'Timed out waiting for the Orca runtime to respond.'
          )
        )
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"state": "start_outcome_unknown"'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"startRequestId"'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"ok": false'))
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })

  it('--retry-start-request 讓第一個 attempt 重用原 mutation id（同 payload 命中原回執）', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation(quotaScenarioMock({}))
    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3,#2'],
        ['from', 'term-coordinator'],
        ['retry-start-request', 'recover-original-start-id']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    const starts = callMock.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    expect(starts[0]?.[2]).toEqual({ orchestrationRequestId: 'recover-original-start-id' })
    // 第二 attempt（遞補）必須換新 id，不得沿用恢復 id。
    expect(starts[1]?.[2]).not.toEqual({ orchestrationRequestId: 'recover-original-start-id' })
    logSpy.mockRestore()
  })

  it('server 明確錯誤（request_mismatch 等）不得當 lost reply 重放', async () => {
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
                { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' }
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
        // production server verdict 子型別：即使 code 撞名 transport 碼也不得重放。
        return Promise.reject(
          new RuntimeRpcFailureError({
            id: 'rpc-1',
            ok: false,
            error: {
              code: 'request_mismatch',
              message: 'Mutation request recover-1 was already used with different input.'
            }
          })
        )
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"state": "start_failed"'))
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('recoveryCommand'))
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })

  it('第二 attempt 回覆遺失＝recovery 指令帶剩餘帳號與 retryOf 血緣', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let startCount = 0
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
                  { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' },
                  { id: 'account-2', email: 'two@example.com', workspaceLabel: 'Codex #2' }
                ],
                activeAccountId: 'account-3'
              }
            }
          })
        }
        if (method === 'accounts.selectCodex') {
          return Promise.resolve({
            result: { accounts: [], activeAccountId: params.accountId }
          })
        }
        if (method === 'orchestration.workerStart') {
          startCount += 1
          if (startCount === 1) {
            // #3 啟動時即回額度錯誤 → 遞補。
            return Promise.resolve({
              result: {
                runId: 'run-1',
                taskId: 'task-1',
                dispatchId: 'dispatch-3',
                state: 'failed',
                lastError: 'Usage limit reached.'
              }
            })
          }
          return Promise.reject(new Error('socket closed before the response arrived'))
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

    // recovery 指令必須從失敗的帳號開始、且帶前一輪的 dispatch 血緣，重放才是同 payload。
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("--accounts '#2'"))
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('--retry-start-retry-of dispatch-3')
    )
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })

  it('recovery 指令 round-trip 全部旗標：重放的 workerStart params 與原呼叫位元組一致', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const makeMock = () => {
      let startCount = 0
      return (method: string, params: { dispatch?: string; accountId?: string }) => {
        if (method === 'status.get') {
          return Promise.resolve({
            result: {
              capabilities: [
                ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY,
                ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
              ]
            }
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
          return Promise.resolve({ result: { accounts: [], activeAccountId: params.accountId } })
        }
        if (method === 'orchestration.workerStart') {
          startCount += 1
          if (startCount === 1) {
            return Promise.resolve({
              result: {
                runId: 'run-1',
                taskId: 'task-1',
                dispatchId: 'dispatch-3',
                state: 'failed',
                lastError: 'Usage limit reached.'
              }
            })
          }
          return Promise.reject(
            new RuntimeClientError('runtime_unavailable', 'socket closed mid-flight')
          )
        }
        if (method === 'orchestration.workerRelease') {
          return Promise.resolve({ result: { state: 'released' } })
        }
        throw new Error(`Unexpected method ${method}`)
      }
    }

    const originalFlags = new Map<string, string | boolean>([
      ['task', 'task-1'],
      ['accounts', '#3,#2'],
      ['worktree', 'current'],
      // 刁鑽值：$、雙引號、單引號、反斜線——shell 貼上不得被展開或破壞。
      ['name', `echo "$HOME" isn't \\ safe`],
      ['model', 'gpt-5.3-codex'],
      ['effort', 'high'],
      ['timeout-ms', '90000'],
      ['run', 'run-1'],
      ['environment', 'staging-runtime'],
      ['from', 'term-coordinator']
    ])
    callMock.mockImplementation(makeMock())
    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: originalFlags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    // 從輸出撈結構化 recoveryArgs 與原第二次 workerStart 呼叫。
    const output = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((t) => t.includes('recoveryArgs'))
    expect(output).toBeDefined()
    const { recoveryArgs, recoveryCommand } = (
      JSON.parse(output!) as { result: { recoveryArgs: string[]; recoveryCommand: string } }
    ).result
    const originalStarts = callMock.mock.calls.filter(
      ([method]) => method === 'orchestration.workerStart'
    )
    const lostCall = originalStarts[1]

    // 結構化 argv → 旗標（零 shell 介入、位元組一致）。
    const parsedFlags = new Map<string, string | boolean>()
    for (let i = 2; i < recoveryArgs.length; i += 1) {
      const token = recoveryArgs[i]!
      if (!token.startsWith('--')) {
        continue
      }
      const flag = token.slice(2)
      if (flag === 'json') {
        continue
      }
      parsedFlags.set(flag, recoveryArgs[i + 1]!)
      i += 1
    }
    // runtime 身分必須保留在 recovery 中。
    expect(parsedFlags.get('environment')).toBe('staging-runtime')
    // 人讀指令對刁鑽值必須用單引號包裹，避免 shell 展開（含 $、雙引號、單引號、反斜線）。
    expect(recoveryCommand).toContain(`'echo "$HOME" isn'\\''t \\ safe'`)

    // 以 recovery 旗標重跑（模擬使用者照指令執行）。
    callMock.mockClear()
    callMock.mockImplementation((method: string, params: { accountId?: string }) => {
      if (method === 'status.get') {
        return Promise.resolve({
          result: {
            capabilities: [
              ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY,
              ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
            ]
          }
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
              activeAccountId: 'account-2'
            }
          }
        })
      }
      if (method === 'accounts.selectCodex') {
        return Promise.resolve({ result: { accounts: [], activeAccountId: params.accountId } })
      }
      if (method === 'orchestration.workerStart') {
        return Promise.reject(
          new RuntimeClientError('runtime_timeout', 'still timing out — capture params only')
        )
      }
      throw new Error(`Unexpected method ${method}`)
    })
    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: parsedFlags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    const replayStart = callMock.mock.calls.find(
      ([method]) => method === 'orchestration.workerStart'
    )
    // 深度比對：params 與 mutation id 必須與遺失的原呼叫完全一致。
    expect(replayStart?.[1]).toEqual(lostCall?.[1])
    expect(replayStart?.[2]).toEqual(lostCall?.[2])
    logSpy.mockRestore()
  })

  it('pairing-code 會話拒絕組出 durable recovery 指令（不落 secret）', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation((method: string, params: { accountId?: string }) => {
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
                { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' }
              ],
              activeAccountId: 'account-3'
            }
          }
        })
      }
      if (method === 'accounts.selectCodex') {
        return Promise.resolve({ result: { accounts: [], activeAccountId: params.accountId } })
      }
      if (method === 'orchestration.workerStart') {
        return Promise.reject(new RuntimeClientError('runtime_timeout', 'timed out'))
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3'],
        ['pairing-code', 'secret-pairing-token'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    const all = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(all).toContain('start_outcome_unknown')
    // secret 絕不落 durable 輸出；也不給會連錯 runtime 的指令。
    expect(all).not.toContain('secret-pairing-token')
    expect(all).not.toContain('recoveryCommand')
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })
})
