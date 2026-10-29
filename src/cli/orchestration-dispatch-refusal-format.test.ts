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

// Runtime envelopes may contain codes introduced after this client; formatting must preserve them.
describe('orchestration dispatch refusals through the CLI error boundary', () => {
  it.each([
    {
      receipt: taskNotFoundRefusal('Task not found: task_missing', { taskId: 'task_missing' }),
      recovery: /task-create|task-list/
    },
    {
      receipt: taskNotStartableRefusal(
        'Task task_child is pending; only ready tasks can be dispatched',
        { taskId: 'task_child', status: 'pending', unmetDependencies: ['task_parent'] }
      ),
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

it('prints an unknown code with its message and nextSteps unchanged', () => {
  const failure: RuntimeRpcFailure = {
    id: 'rpc_1',
    ok: false,
    error: {
      code: 'code_from_a_newer_host',
      message: 'Refused for a reason this CLI has never heard of.',
      data: { nextSteps: ['Do the thing the newer host suggested.'] }
    },
    _meta: { runtimeId: 'runtime_1' }
  }
  const error = new RuntimeRpcFailureError(failure)

  expect(formatCliError(error, { commandPath: ['orchestration', 'dispatch'] })).toBe(
    'Refused for a reason this CLI has never heard of.\nNext step: Do the thing the newer host suggested.'
  )
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  reportCliError(error, true, { commandPath: ['orchestration', 'dispatch'] })
  expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(failure)
})

function envelope(receipt: DispatchRefusalReceipt): RuntimeRpcFailure {
  return { id: 'rpc_1', ok: false, error: receipt, _meta: { runtimeId: 'runtime_1' } }
}
