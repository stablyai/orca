import { expect, it, vi } from 'vitest'
import { SshPortForwardRetirementCohort } from './ssh-port-forward-retirement-cohort'
import type { StartedPortForward } from './ssh-port-forward-provider'

function forward() {
  const proof = { drain: vi.fn(async (_signal: AbortSignal) => {}), assertDrained: vi.fn() }
  const resource = {
    entry: {
      id: 'forward',
      connectionId: 'target',
      localPort: 3000,
      remoteHost: 'localhost',
      remotePort: 4000
    },
    close: vi.fn(async () => {}),
    dispose: vi.fn(),
    fenceForDrain: vi.fn(() => proof)
  } satisfies StartedPortForward
  return { resource, proof }
}

const signal = () => new AbortController().signal

const resetRequest = {
  version: 1 as const,
  operationId: 'reset-operation',
  runtimeIncarnation: 'runtime',
  ownerGeneration: 1,
  ownerLease: 'lease'
}

it('validates the entire reset receipt cohort before removing any instance', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  const first = forward().resource
  const second = forward().resource
  Object.assign(first, { resetRetirementConfirmed: resetRequest })
  Object.assign(second, { resetRetirementConfirmed: { ...resetRequest, ownerLease: 'other' } })
  cohort.register(first)
  cohort.register(second)
  await cohort.fenceForDrain().drain(signal())
  expect(() => cohort.reconcileResetRetirement(resetRequest)).toThrow('receipt_mismatch')
  Object.assign(first, { resetRetirementConfirmed: undefined })
  Object.assign(second, { resetRetirementConfirmed: resetRequest })
  expect(() => cohort.reconcileResetRetirement(resetRequest)).toThrow('invalid_request')
  Object.assign(first, { resetRetirementConfirmed: resetRequest })
  cohort.reconcileResetRetirement(resetRequest)
  expect(cohort.isEmpty).toBe(true)
})

it('does not let matching reset receipts clear an earlier uncertain failure', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  const selected = forward().resource
  Object.assign(selected, { resetRetirementConfirmed: resetRequest })
  cohort.register(selected)
  await cohort.fenceForDrain().drain(signal())
  cohort.fail(new Error('old forwarding uncertainty'))
  expect(() => cohort.reconcileResetRetirement(resetRequest)).toThrow('old forwarding uncertainty')
  expect(cohort.isEmpty).toBe(false)
})

it('requires closed admission and settled startup before reset receipt reconciliation', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  expect(() => cohort.reconcileResetRetirement(resetRequest)).toThrow('reset_not_fenced')
  const reservation = cohort.reserveStart()
  cohort.fenceForDrain()
  expect(() => cohort.reconcileResetRetirement(resetRequest)).toThrow()
  reservation.release()
  cohort.reconcileResetRetirement(resetRequest)
  expect(cohort.isEmpty).toBe(true)
})

it('prunes only explicit retirement receipts, never a successful close alone', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  const a = forward()
  cohort.register(a.resource)
  await a.resource.close()
  cohort.pruneRetired()
  expect(cohort.isEmpty).toBe(false)
  expect(() => cohort.assertReconciled()).toThrow('reconciliation_required')
  Object.assign(a.resource, { retirementConfirmed: true })
  cohort.assertReconciled()
  expect(cohort.isEmpty).toBe(true)
  const fence = cohort.fenceForDrain()
  await fence.drain(signal())
  fence.assertDrained()
  expect(a.resource.fenceForDrain).not.toHaveBeenCalled()
})

it('preserves existing drain verification when a receipt prunes a closed instance', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  const selected = forward().resource
  cohort.register(selected)
  const fence = cohort.fenceForDrain()
  await fence.drain(signal())
  Object.assign(selected, { retirementConfirmed: true })
  cohort.pruneRetired()
  fence.assertDrained()
  cohort.fail(new Error('earlier failure remains'))
  expect(fence.assertDrained).toThrow('earlier failure remains')
})

it('never clears retained uncertainty when a later retirement receipt arrives', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  const a = forward()
  cohort.register(a.resource)
  cohort.fail(new Error('earlier traffic unverifiable'))
  Object.assign(a.resource, { retirementConfirmed: true })
  cohort.pruneRetired()
  expect(cohort.isEmpty).toBe(true)
  expect(() => cohort.assertReconciled()).toThrow('earlier traffic unverifiable')
  await expect(cohort.fenceForDrain().drain(signal())).rejects.toThrow(
    'earlier traffic unverifiable'
  )
})

it('retains exact instances independently of visible identity and fences only once', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  expect(cohort.isEmpty).toBe(true)
  const a = forward()
  const b = forward()
  cohort.register(a.resource)
  cohort.register(a.resource)
  cohort.register(b.resource)
  expect(cohort.isEmpty).toBe(false)
  cohort.assertAdmission()
  const fence = cohort.fenceForDrain()
  cohort.fenceForDrain()
  expect(a.resource.fenceForDrain).toHaveBeenCalledOnce()
  expect(b.resource.fenceForDrain).toHaveBeenCalledOnce()
  expect(() => cohort.assertAdmission()).toThrow('admission_closed')
  expect(fence.assertDrained).toThrow('not_drained')
  await fence.drain(signal())
  fence.assertDrained()
  expect(a.resource.close).not.toHaveBeenCalled()
  expect(a.resource.dispose).not.toHaveBeenCalled()
})

it('captures late registrations synchronously and repeats drain across revision changes', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  const a = forward()
  const b = forward()
  const pending = Promise.withResolvers<void>()
  b.proof.drain.mockReturnValue(pending.promise)
  a.proof.drain.mockImplementationOnce(async () => {
    cohort.register(b.resource)
    expect(b.resource.fenceForDrain).toHaveBeenCalledOnce()
  })
  cohort.register(a.resource)
  const fence = cohort.fenceForDrain()
  const done = vi.fn()
  const waiting = fence.drain(signal()).then(done)
  await vi.waitFor(() => expect(b.proof.drain).toHaveBeenCalledOnce())
  expect(done).not.toHaveBeenCalled()
  pending.resolve()
  await waiting
  expect(a.proof.drain).toHaveBeenCalledTimes(2)
  fence.assertDrained()
})

it('invalidates earlier proof when a provider arrives after successful drain', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  const fence = cohort.fenceForDrain()
  await fence.drain(signal())
  cohort.register(forward().resource)
  expect(fence.assertDrained).toThrow('not_drained')
  await fence.drain(signal())
  fence.assertDrained()
})

it.each(['opaque', 'throws'] as const)(
  'fences every instance despite %s provider and retains failure',
  async (kind) => {
    const cohort = new SshPortForwardRetirementCohort()
    const a = forward()
    const b = forward()
    if (kind === 'opaque') {
      cohort.register({ ...a.resource, fenceForDrain: undefined })
    } else {
      a.resource.fenceForDrain.mockImplementation(() => {
        throw new Error('fence failed')
      })
      cohort.register(a.resource)
    }
    cohort.register(b.resource)
    const fence = cohort.fenceForDrain()
    expect(b.resource.fenceForDrain).toHaveBeenCalledOnce()
    await expect(fence.drain(signal())).rejects.toThrow()
    await expect(fence.drain(signal())).rejects.toThrow()
    expect(fence.assertDrained).toThrow()
    expect(b.resource.dispose).not.toHaveBeenCalled()
  }
)

it('late missing capability wakes a drain even when another provider never settles', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  const a = forward()
  a.proof.drain.mockReturnValue(new Promise(() => {}))
  cohort.register(a.resource)
  const fence = cohort.fenceForDrain()
  const waiting = fence.drain(signal())
  cohort.register({ ...forward().resource, fenceForDrain: undefined })
  await expect(waiting).rejects.toThrow('capability_unavailable')
})

it('abort cancels observation only; later provider failure remains sticky', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  const a = forward()
  const pending = Promise.withResolvers<void>()
  a.proof.drain.mockReturnValue(pending.promise)
  cohort.register(a.resource)
  const fence = cohort.fenceForDrain()
  const controller = new AbortController()
  const waiting = fence.drain(controller.signal)
  await Promise.resolve()
  controller.abort(new Error('observer aborted'))
  await expect(waiting).rejects.toThrow('observer aborted')
  pending.reject(new Error('late write failure'))
  await vi.waitFor(() => expect(fence.assertDrained).toThrow('late write failure'))
  await expect(fence.drain(signal())).rejects.toThrow('late write failure')
})

it('allows retry after observer abort when the provider eventually drains', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  const a = forward()
  const pending = Promise.withResolvers<void>()
  a.proof.drain.mockReturnValue(pending.promise)
  cohort.register(a.resource)
  const fence = cohort.fenceForDrain()
  const controller = new AbortController()
  const waiting = fence.drain(controller.signal)
  controller.abort(new Error('stop waiting'))
  await expect(waiting).rejects.toThrow('stop waiting')
  pending.resolve()
  await fence.drain(signal())
  fence.assertDrained()
})

it('external closure failure cannot disappear with removed rows or affect another cohort', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  const other = new SshPortForwardRetirementCohort()
  cohort.register(forward().resource)
  const fence = cohort.fenceForDrain()
  await fence.drain(signal())
  cohort.fail(new Error('removed listener close failed'))
  expect(fence.assertDrained).toThrow('removed listener close failed')
  await expect(fence.drain(signal())).rejects.toThrow('removed listener close failed')
  other.assertAdmission()
  await other.fenceForDrain().drain(signal())
})

it('rechecks revisions after reentrant final assertions', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  const a = forward()
  const b = forward()
  let bDrained = false
  b.proof.drain.mockImplementation(async () => {
    bDrained = true
  })
  b.proof.assertDrained.mockImplementation(() => {
    if (!bDrained) {
      throw new Error('late provider not drained')
    }
  })
  cohort.register(a.resource)
  a.proof.assertDrained.mockImplementationOnce(() => cohort.register(b.resource))
  const fence = cohort.fenceForDrain()
  await fence.drain(signal())
  expect(b.proof.drain).toHaveBeenCalledOnce()
  fence.assertDrained()
})

it('retains historical failure for reset without preventing ordinary pre-reset work', async () => {
  const cohort = new SshPortForwardRetirementCohort()
  cohort.fail(new Error('previous close unconfirmed'))
  cohort.assertAdmission()
  const a = forward()
  cohort.register(a.resource)
  cohort.assertAdmission()
  const fence = cohort.fenceForDrain()
  expect(a.resource.fenceForDrain).toHaveBeenCalledOnce()
  await expect(fence.drain(signal())).rejects.toThrow('previous close unconfirmed')
})
