import assert from 'node:assert/strict'
import test from 'node:test'
import {
  openRelayLoadInviteOffers,
  proveRelayLoadRequestUnitBoundary
} from './relay-load-request-unit-boundary.mjs'

test('distributes the exact invite count with bounded concurrency', async () => {
  let active = 0
  let peak = 0
  const delays = []
  const calls = [0, 0, 0]
  const peers = calls.map((_, index) => ({
    async openInviteOffer() {
      calls[index]++
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
    }
  }))
  assert.equal(await openRelayLoadInviteOffers({
    peers,
    count: 8,
    ratePerSecond: 2,
    concurrency: 2,
    delay: async (milliseconds) => { delays.push(milliseconds) },
    now: () => 0
  }), 8)
  assert.deepEqual(calls, [3, 3, 2])
  assert.ok(peak <= 2)
  assert.equal(delays.length, 8)
  assert.ok(Math.max(...delays) >= 3_500)
})

test('accepts only the exact request-unit exhaustion error', async () => {
  assert.equal(await proveRelayLoadRequestUnitBoundary({
    openInviteOffer: async () => {
      throw new Error('invite offer failed: relay_capacity_exhausted')
    }
  }), 'relay_capacity_exhausted')
  await assert.rejects(
    proveRelayLoadRequestUnitBoundary({
      openInviteOffer: async () => { throw new Error('control response timeout') }
    }),
    /not rejected safely/
  )
  await assert.rejects(
    proveRelayLoadRequestUnitBoundary({ openInviteOffer: async () => undefined }),
    /unexpectedly succeeded/
  )
})
