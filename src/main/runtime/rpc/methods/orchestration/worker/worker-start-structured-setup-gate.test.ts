import { afterEach, expect, it, vi } from 'vitest'
import { awaitStructuredWorkerSetupGate } from './worker-start-structured-setup-gate'
import type { WorkerEffect, WorkerSetupReceipt } from './worker-topology'

const setup: WorkerSetupReceipt = {
  requested: 'run',
  effective: 'run',
  source: 'repo',
  hookFound: true,
  startupPolicy: 'wait-for-setup',
  state: 'running'
}

afterEach(() => vi.useRealTimers())

it('blocks dispatch input when the required setup terminal is missing', async () => {
  const gate = await awaitStructuredWorkerSetupGate({
    runtime: { waitForSetupTerminalCompletion: async () => ({ exitCode: 0 }) },
    setup,
    effects: [],
    timeoutMs: 1000
  })
  expect(gate).toMatchObject({ satisfied: false, status: 'unverifiable' })
})

it('blocks dispatch input when observing setup completion fails', async () => {
  const effects: WorkerEffect[] = [{ kind: 'setup', terminalId: 'setup-1' }]
  const gate = await awaitStructuredWorkerSetupGate({
    runtime: {
      waitForSetupTerminalCompletion: async () => {
        throw new Error('lost terminal')
      }
    },
    setup,
    effects,
    timeoutMs: 1000
  })
  expect(gate).toMatchObject({ satisfied: false, status: 'unverifiable' })
  expect(effects).toContainEqual({
    kind: 'setup',
    action: 'wait_unevaluated',
    state: 'lost terminal'
  })
})

it('cancels the completion observer when a worker setup deadline expires', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined
  const pending = awaitStructuredWorkerSetupGate({
    runtime: {
      waitForSetupTerminalCompletion: (_handle, observedSignal) => {
        signal = observedSignal
        return new Promise(() => {})
      }
    },
    setup,
    effects: [{ kind: 'setup', terminalId: 'setup-1' }],
    timeoutMs: 1000
  })
  await vi.advanceTimersByTimeAsync(1000)
  expect(await pending).toMatchObject({ satisfied: false, status: 'timeout' })
  expect(signal?.aborted).toBe(true)
})
