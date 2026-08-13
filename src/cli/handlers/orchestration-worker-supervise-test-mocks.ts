// worker-supervise 測試共用的 quota 情境 mock factory。
import { ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

export const quotaScenarioMock = (overrides: {
  stopState?: string
  releaseState?: string
  selectSecondActive?: string
}) => {
  let startCount = 0
  let activeAccountId = 'account-3'
  return (method: string, params: { dispatch?: string; accountId?: string }) => {
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
            activeAccountId
          }
        }
      })
    }
    if (method === 'accounts.selectCodex') {
      const isSecond = params.accountId === 'account-2'
      activeAccountId =
        isSecond && overrides.selectSecondActive
          ? overrides.selectSecondActive
          : (params.accountId ?? activeAccountId)
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
              ? [{ role: 'system', blocks: [{ type: 'text', text: 'Usage limit reached.' }] }]
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
      return Promise.resolve({ result: { state: overrides.stopState ?? 'stopped' } })
    }
    if (method === 'orchestration.workerRelease') {
      return Promise.resolve({ result: { state: overrides.releaseState ?? 'released' } })
    }
    throw new Error(`Unexpected method ${method}`)
  }
}
