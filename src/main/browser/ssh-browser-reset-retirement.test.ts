import { describe, expect, it, vi } from 'vitest'
import type { RelayOwnerResetRequest } from '../../shared/relay-owner-reset-contract'
import {
  assertSshBrowserResourcesAbsent,
  captureSshBrowserResetRetirement,
  retainSshBrowserRoute
} from './ssh-browser-route-lifetimes'

let targetSequence = 0
const request: RelayOwnerResetRequest = {
  version: 1,
  operationId: 'browser-reset-operation',
  runtimeIncarnation: 'browser-reset-runtime',
  ownerGeneration: 3,
  ownerLease: 'browser-reset-lease'
}

async function setup() {
  const targetId = `browser-reset-retirement-${++targetSequence}`
  const connection = {}
  const tunnel: { resetRetirementRequest?: RelayOwnerResetRequest } = {}
  const closed = Promise.withResolvers<void>()
  const close = vi.fn(() => closed.promise)
  const route = await retainSshBrowserRoute(targetId, async (allocation) => {
    allocation.started = true
    allocation.retirementConfirmed = () => false
    allocation.resetBinding = { connection, tunnel }
    return {
      key: targetId,
      connect: () => {
        throw new Error('unused')
      },
      isValid: () => true,
      close
    }
  })
  const assertAuthority = vi.fn()
  const capture = () =>
    captureSshBrowserResetRetirement({ targetId, connection, request, assertAuthority })
  const finishClose = async () => {
    const pending = route.close()
    closed.resolve()
    await pending
  }
  return { targetId, connection, tunnel, closed, route, close, capture, finishClose }
}

describe('SSH browser reset retirement', () => {
  it('retains uncertainty if final transport revalidation fails after token retirement', async () => {
    const state = await setup()
    state.tunnel.resetRetirementRequest = request
    const retirement = state.capture()
    await state.finishClose()
    let assertions = 0
    expect(() =>
      retirement.reconcile(() => {
        if (++assertions === 3) {
          throw new Error('final transport proof changed')
        }
      })
    ).toThrow('final transport proof changed')
    expect(() => assertSshBrowserResourcesAbsent(state.targetId)).toThrow(
      'final transport proof changed'
    )
    expect(() => retirement.assertReconciled()).toThrow('final transport proof changed')
  })

  it('retains a locally closed route without exact preparation request evidence', async () => {
    const state = await setup()
    const retirement = state.capture()
    await state.finishClose()
    expect(() => retirement.reconcile(() => {})).toThrow('relay_reset_invalid_request')
    expect(() => retirement.assertReconciled()).toThrow('ssh_browser_reset_retirement_unconfirmed')
    expect(() => assertSshBrowserResourcesAbsent(state.targetId)).toThrow()
  })

  it('retains a route while its local close is pending', async () => {
    const state = await setup()
    state.tunnel.resetRetirementRequest = request
    const retirement = state.capture()
    const pending = state.route.close()
    expect(() => retirement.reconcile(() => {})).toThrow(
      'ssh_browser_reset_local_close_unconfirmed'
    )
    expect(() => assertSshBrowserResourcesAbsent(state.targetId)).toThrow()
    state.closed.resolve()
    await pending
    retirement.reconcile(() => {})
    expect(() => assertSshBrowserResourcesAbsent(state.targetId)).not.toThrow()
  })

  it('retires exact connection resources after full request, local close, and transport proof', async () => {
    const state = await setup()
    state.tunnel.resetRetirementRequest = { ...request }
    const retirement = state.capture()
    await state.finishClose()
    const assertTransportRetired = vi.fn()
    retirement.reconcile(assertTransportRetired)
    expect(assertTransportRetired).toHaveBeenCalled()
    expect(() => retirement.assertReconciled()).not.toThrow()
    expect(() => assertSshBrowserResourcesAbsent(state.targetId)).not.toThrow()
  })

  it('retains failed transport proof and allows a later confirmed retry', async () => {
    const state = await setup()
    state.tunnel.resetRetirementRequest = request
    const retirement = state.capture()
    await state.finishClose()
    expect(() =>
      retirement.reconcile(() => {
        throw new Error('transport_unverifiable')
      })
    ).toThrow('transport_unverifiable')
    expect(() => assertSshBrowserResourcesAbsent(state.targetId)).toThrow()
    retirement.reconcile(() => {})
    expect(() => retirement.assertReconciled()).not.toThrow()
    expect(() => assertSshBrowserResourcesAbsent(state.targetId)).not.toThrow()
  })

  it.each([
    { operationId: 'other-operation' },
    { runtimeIncarnation: 'other-runtime' },
    { ownerGeneration: 4 },
    { ownerLease: 'other-lease' }
  ])('retains routes whose request differs by %j', async (change) => {
    const state = await setup()
    state.tunnel.resetRetirementRequest = { ...request, ...change }
    const retirement = state.capture()
    await state.finishClose()
    expect(() => retirement.reconcile(() => {})).toThrow('ssh_browser_reset_request_changed')
    expect(() => assertSshBrowserResourcesAbsent(state.targetId)).toThrow()
  })

  it('refuses cohort mutation while a newly admitted route is still opening', async () => {
    const state = await setup()
    state.tunnel.resetRetirementRequest = request
    const retirement = state.capture()
    await state.finishClose()
    const opening = Promise.withResolvers<never>()
    const newRoute = retainSshBrowserRoute(state.targetId, async () => opening.promise)
    expect(() => retirement.reconcile(() => {})).toThrow('ssh_browser_reset_cohort_changed')
    expect(() => assertSshBrowserResourcesAbsent(state.targetId)).toThrow()
    const rejected = expect(newRoute).rejects.toThrow('opening_canceled')
    opening.reject(new Error('opening_canceled'))
    await rejected
    expect(() => retirement.reconcile(() => {})).toThrow('ssh_browser_reset_cohort_changed')
  })

  it('does not retire routes owned by another connection', async () => {
    const state = await setup()
    state.tunnel.resetRetirementRequest = request
    const retirement = captureSshBrowserResetRetirement({
      targetId: state.targetId,
      connection: {},
      request,
      assertAuthority: () => {}
    })
    await state.finishClose()
    retirement.reconcile(() => {})
    expect(() => retirement.assertReconciled()).not.toThrow()
    expect(() => assertSshBrowserResourcesAbsent(state.targetId)).toThrow()
    state.capture().reconcile(() => {})
    expect(() => assertSshBrowserResourcesAbsent(state.targetId)).not.toThrow()
  })

  it('preserves a failed route close as drain failure', async () => {
    const state = await setup()
    state.tunnel.resetRetirementRequest = request
    const retirement = state.capture()
    const pending = state.route.close()
    const rejected = expect(pending).rejects.toThrow('local_close_failed')
    state.closed.reject(new Error('local_close_failed'))
    await rejected
    expect(() => retirement.reconcile(() => {})).toThrow('local_close_failed')
    expect(() => assertSshBrowserResourcesAbsent(state.targetId)).toThrow('local_close_failed')
    expect(state.route.close()).toBe(pending)
    expect(state.close).toHaveBeenCalledTimes(1)
  })
})
