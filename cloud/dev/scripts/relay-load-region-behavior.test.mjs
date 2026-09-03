import assert from 'node:assert/strict'
import test from 'node:test'
import { proveRelayLoadRegionBehavior } from './relay-load-region-behavior.mjs'

function peer(origin, reassigned = origin) {
  let shutdowns = 0
  return {
    connect: async () => undefined,
    assignedCellUrl: () => origin,
    requestAssignment: async () => ({ cellUrl: reassigned }),
    shutdown: async () => { shutdowns++ },
    shutdowns: () => shutdowns
  }
}

test('proves unhinted US-first placement and sticky Asia preservation', async () => {
  const oldClientPeer = peer('https://c3.relay-staging.onorca.dev')
  const stickyPeer = peer('https://c4.relay-staging.onorca.dev')
  let retryDelayMs = 0
  assert.deepEqual(await proveRelayLoadRegionBehavior({
    oldClientPeer,
    stickyPeer,
    asiaOrigin: 'https://c4.relay-staging.onorca.dev',
    scheduleAssignmentRetry: (resolve, delayMs) => {
      retryDelayMs = delayMs
      resolve()
    }
  }), { oldClientUsFirst: true, stickyAssignmentPreserved: true })
  assert.equal(retryDelayMs, 5_100)
  assert.equal(oldClientPeer.shutdowns(), 1)
  assert.equal(stickyPeer.shutdowns(), 1)
})

test('rejects Asia placement for an unhinted client or a moved sticky assignment', async () => {
  await assert.rejects(proveRelayLoadRegionBehavior({
    oldClientPeer: peer('https://c4.relay-staging.onorca.dev'),
    stickyPeer: peer('https://c4.relay-staging.onorca.dev'),
    asiaOrigin: 'https://c4.relay-staging.onorca.dev',
    scheduleAssignmentRetry: (resolve) => resolve()
  }), /US-first/)
  await assert.rejects(proveRelayLoadRegionBehavior({
    oldClientPeer: peer('https://c3.relay-staging.onorca.dev'),
    stickyPeer: peer('https://c4.relay-staging.onorca.dev', 'https://c3.relay-staging.onorca.dev'),
    asiaOrigin: 'https://c4.relay-staging.onorca.dev',
    scheduleAssignmentRetry: (resolve) => resolve()
  }), /sticky assignment moved/)
})
