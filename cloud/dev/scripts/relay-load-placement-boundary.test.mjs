import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  proveRelayLoadPlacementBoundary,
  proveRelayLoadRegionalFallback
} from './relay-load-placement-boundary.mjs'

function peer(connect) {
  return { connect, shutdown: async () => undefined }
}

test('requires the next fresh placement to receive HTTP 503', async () => {
  assert.equal(
    await proveRelayLoadPlacementBoundary({
      peer: peer(async () => {
        throw new Error('relay assignment failed: 503 relay_connection_headroom_exhausted')
      }),
      failureReason: (error) =>
        error.message === 'relay assignment failed: 503 relay_connection_headroom_exhausted'
          ? 'assignment_capacity_exhausted'
          : 'unknown'
    }),
    'assignment_capacity_exhausted'
  )
  await assert.rejects(
    proveRelayLoadPlacementBoundary({
      peer: peer(async () => undefined),
      failureReason: () => 'unknown'
    }),
    /placement overflow unexpectedly connected/
  )
})

test('requires a preferred-region fallback to leave the full cell', async () => {
  let shutdowns = 0
  assert.equal(await proveRelayLoadRegionalFallback({
    peer: {
      connect: async () => undefined,
      assignedCellUrl: () => 'https://c3.relay-staging.onorca.dev',
      shutdown: async () => { shutdowns++ }
    },
    blockedOrigin: 'https://c4.relay-staging.onorca.dev'
  }), true)
  assert.equal(shutdowns, 1)
  await assert.rejects(proveRelayLoadRegionalFallback({
    peer: {
      connect: async () => undefined,
      assignedCellUrl: () => 'https://c4.relay-staging.onorca.dev',
      shutdown: async () => undefined
    },
    blockedOrigin: 'https://c4.relay-staging.onorca.dev'
  }), /did not leave/)
})
