import { afterEach, expect, it, vi } from 'vitest'
import {
  captureRuntime,
  createCheckpointRuntime,
  MODEL_BUDGET
} from './headless-model-checkpoint-test-fixture'
import { PTY_ID } from './headless-hydration-ownership-test-fixture'
import { makeDeferred } from './orca-runtime-test-fixtures.spec'
import {
  TerminalModelCheckpointLeases,
  TERMINAL_MODEL_LEASE_TTL_MS
} from './terminal-model-checkpoint-leases'

const owner = { viewerId: 'lease-finalizer', ptyId: PTY_ID }
afterEach(() => vi.useRealTimers())

it('releases the host exit subscription exactly once on idle expiry', async () => {
  const runtime = createCheckpointRuntime()
  const captured = await captureRuntime(runtime)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const leases = new TerminalModelCheckpointLeases(MODEL_BUDGET * 2)
  const finalized = vi.fn()
  try {
    const lease = await leases.capture(owner, async () => captured, finalized)
    expect(lease).not.toBeNull()
    expect(finalized).not.toHaveBeenCalled()
    vi.advanceTimersByTime(TERMINAL_MODEL_LEASE_TTL_MS)
    expect(finalized).toHaveBeenCalledOnce()
    expect(captured.checkpoint.isDisposed).toBe(true)
    expect(leases.byteSize).toBe(0)
    leases.dispose()
    expect(finalized).toHaveBeenCalledOnce()
  } finally {
    leases.dispose()
  }
})

it('finalizes a canceled pending capture after its actual resource owner settles', async () => {
  const runtime = createCheckpointRuntime()
  const captured = await captureRuntime(runtime)
  const gate = makeDeferred()
  const leases = new TerminalModelCheckpointLeases(MODEL_BUDGET * 2)
  const finalized = vi.fn()
  const pending = leases.capture(
    owner,
    async () => {
      await gate.promise
      return captured
    },
    finalized
  )
  leases.dispose()
  expect(finalized).not.toHaveBeenCalled()
  expect(leases.byteSize).toBe(MODEL_BUDGET * 2)
  gate.resolve()
  await expect(pending).resolves.toBeNull()
  expect(finalized).toHaveBeenCalledOnce()
  expect(captured.checkpoint.isDisposed).toBe(true)
  expect(leases.byteSize).toBe(0)
})

it('finalizes a failed load without finalizing requests rejected before admission', async () => {
  const leases = new TerminalModelCheckpointLeases(0)
  const declinedFinalizer = vi.fn()
  const load = vi.fn()
  await expect(leases.capture(owner, load, declinedFinalizer)).resolves.toBeNull()
  expect(load).not.toHaveBeenCalled()
  expect(declinedFinalizer).not.toHaveBeenCalled()
  const admitted = new TerminalModelCheckpointLeases(MODEL_BUDGET * 2)
  const failedFinalizer = vi.fn()
  await expect(
    admitted.capture(
      owner,
      async () => {
        throw new Error('load failed')
      },
      failedFinalizer
    )
  ).rejects.toThrow('load failed')
  expect(failedFinalizer).toHaveBeenCalledOnce()
  expect(admitted.byteSize).toBe(0)
  admitted.dispose()
})
