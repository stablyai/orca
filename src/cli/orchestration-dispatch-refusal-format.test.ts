import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  injectRejectedRefusal,
  taskNotFoundRefusal,
  taskNotStartableRefusal,
  type DispatchRefusalReceipt
} from '../shared/orchestration-dispatch-refusal-contract'
import { formatCliError, reportCliError } from './format'
import { RuntimeRpcFailureError, type RuntimeRpcFailure } from './runtime/types'

afterEach(() => {
  vi.restoreAllMocks()
})

// Why: these are the exact envelopes the RPC dispatcher test proved the runtime emits. The CLI
// never enumerates codes, so an older CLI prints the same recovery for a code it has never seen.
describe('orchestration dispatch refusals through the CLI error boundary', () => {
  it.each([
    {
      receipt: taskNotFoundRefusal('task_missing'),
      recovery: /task-create|task-list/
    },
    {
      receipt: taskNotStartableRefusal({
        taskId: 'task_child',
        status: 'pending',
        unmetDependencies: ['task_parent']
      }),
      recovery: /task_parent/
    },
    {
      receipt: injectRejectedRefusal('term_worker', 'no_agent_detected'),
      recovery: /without --inject/
    }
  ])('prints $receipt.code with its recovery in human and JSON output', ({ receipt, recovery }) => {
    const failure = envelope(receipt)
    const error = new RuntimeRpcFailureError(failure)
    expect(error.code).toBe(receipt.code)

    const human = formatCliError(error, { commandPath: ['orchestration', 'dispatch'] })
    expect(human).toContain(receipt.message)
    expect(human).toMatch(recovery)

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    reportCliError(error, true, { commandPath: ['orchestration', 'dispatch'] })
    const printed = JSON.parse(log.mock.calls[0]?.[0] as string) as RuntimeRpcFailure
    expect(printed.ok).toBe(false)
    expect(printed.error).toEqual(receipt)
  })
})

function envelope(receipt: DispatchRefusalReceipt): RuntimeRpcFailure {
  return { id: 'rpc_1', ok: false, error: receipt, _meta: { runtimeId: 'runtime_1' } }
}
