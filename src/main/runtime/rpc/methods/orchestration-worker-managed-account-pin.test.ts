import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { ORCHESTRATION_METHODS } from './orchestration'

// 驗證 workerStart 以 PTY 啟動帳號登錄表 pin 受管帳號：
// 回執絕不為工人實際未使用的帳號背書（ABA race 免疫、無紀錄即 fail-closed）。

describe('orchestration workerStart managed-account pin', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  function setup(launchAccount: { known: boolean; accountId: string | null }): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : handle === 'term_worker' ? workerPaneKey : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker'
        ? ({
            terminalHandle: handle,
            paneKey: workerPaneKey,
            processIncarnation: 'runtime_test:term_worker:1',
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::worktree'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_worker',
      closed: true
    } as never)
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'getCodexTerminalLaunchAccount').mockReturnValue(launchAccount)
    activeRunId = db.createRun({
      objective: 'Managed-account pin test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    ctx = { runtime }
  }

  afterEach(() => {
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
    vi.restoreAllMocks()
  })

  async function call(name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  async function startWorker(managedAccount?: { provider: string; id: string; label: string }) {
    const task = db.createTask({ spec: 'managed-account pin fixture task', runId: activeRunId })
    return (await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex',
      ...(managedAccount ? { managedAccount } : {})
    })) as { dispatchId: string; state: string; failedStage?: string; lastError?: string }
  }

  it('登錄帳號與請求一致才 ready，回執記錄該帳號', async () => {
    setup({ known: true, accountId: 'account-3' })
    const result = await startWorker({ provider: 'codex', id: 'account-3', label: 'Codex #3' })
    expect(result.state).toBe('ready')
    const worker = db.getWorkerDispatch(result.dispatchId)
    const startOptions = JSON.parse(worker?.start_options ?? '{}') as {
      managedAccount?: { id?: string }
    }
    expect(startOptions.managedAccount?.id).toBe('account-3')
  })

  it('PTY 實際啟動帳號不同（ABA 情境）即 start 失敗，自建終端即刻關閉', async () => {
    setup({ known: true, accountId: 'account-2' })
    const result = await startWorker({ provider: 'codex', id: 'account-3', label: 'Codex #3' })
    expect(result.state).not.toBe('ready')
    expect(result.failedStage).toBe('account_verification')
    expect(result.lastError).toContain('launched under Codex account account-2')
    // 驗證失敗的新建終端不得存活成無主資源。
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
    // 清理結果必須持久化到回執 effects，不能只留在記憶體。
    const worker = db.getWorkerDispatch(result.dispatchId)
    const effects = JSON.parse(worker?.effects ?? '[]') as { kind?: string; action?: string }[]
    expect(effects.some((e) => e.kind === 'terminal' && e.action === 'closed')).toBe(true)
  })

  it('managedAccount 禁止走 federated（--on）路徑，guard 先於分流', async () => {
    setup({ known: true, accountId: 'account-3' })
    const task = db.createTask({ spec: 'federated guard task', runId: activeRunId })
    await expect(
      call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex',
        on: 'windows',
        managedAccount: { provider: 'codex', id: 'account-3', label: 'Codex #3' }
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('managedAccount 禁止搭配非 codex agent', async () => {
    setup({ known: true, accountId: 'account-3' })
    const task = db.createTask({ spec: 'agent guard task', runId: activeRunId })
    await expect(
      call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'claude',
        managedAccount: { provider: 'codex', id: 'account-3', label: 'Codex #3' }
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('managedAccount 禁止搭配 reused terminal（spawn 後重啟的帳號無法佐證）', async () => {
    setup({ known: true, accountId: 'account-3' })
    const task = db.createTask({ spec: 'terminal guard task', runId: activeRunId })
    await expect(
      call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex',
        terminal: 'term_worker',
        managedAccount: { provider: 'codex', id: 'account-3', label: 'Codex #3' }
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      // Why: prepareLocalWorkerStart also rejects agent+terminal with invalid_argument; the
      // message binds this test to the managed-account terminal guard specifically.
      message: expect.stringContaining('cannot be combined with --terminal')
    })
  })

  it('登錄表無紀錄＝無法證明，fail-closed', async () => {
    setup({ known: false, accountId: null })
    const result = await startWorker({ provider: 'codex', id: 'account-3', label: 'Codex #3' })
    expect(result.state).not.toBe('ready')
    expect(result.failedStage).toBe('account_verification')
    expect(result.lastError).toContain('cannot be proven')
  })

  it('未請求受管帳號時不做驗證、照常 ready', async () => {
    setup({ known: false, accountId: null })
    const result = await startWorker()
    expect(result.state).toBe('ready')
  })
})
