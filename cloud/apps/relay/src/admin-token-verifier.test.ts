import { describe, expect, it } from 'vitest'
import { relayAdminIdentityMayAccess } from './admin-token-verifier.js'

const monitorReads = [
  '/v1/admin/admission-selector/status',
  '/v1/admin/cell-status',
  '/v1/admin/evacuation-status',
  '/v1/admin/host-whereabouts',
  '/v1/admin/regional-rehome-control',
  '/v1/admin/regional-rehome-preview',
  '/v1/admin/runtime-status'
]
const fenceReads = [
  ...monitorReads,
  '/v1/admin/evacuation-capacity',
  '/v1/admin/cell-fence-attempt-status'
]
const capacityRoutes = [
  '/v1/admin/admission-selector/status',
  '/v1/admin/admission-selector/apply',
  '/v1/admin/cell-state',
  '/v1/admin/cell-status',
  '/v1/admin/runtime-status',
  '/v1/admin/drain'
]
const asiaProofRoutes = [
  '/v1/admin/admission-selector/status',
  '/v1/admin/admission-selector/apply-staging-asia-proof',
  '/v1/admin/cell-status',
  '/v1/admin/runtime-status'
]
const brokerMutations = [
  '/v1/admin/cell-fence-adopt-legacy',
  '/v1/admin/cell-fence-commit-legacy-adoption',
  '/v1/admin/cell-fence-attest',
  '/v1/admin/cell-fence-attempt-prepare',
  '/v1/admin/cell-fence-attempt-start',
  '/v1/admin/cell-fence-attempt-plan',
  '/v1/admin/cell-fence-attempt-operation',
  '/v1/admin/cell-fence-attempt-abort',
  '/v1/admin/migration-supersede-cell'
]
const brokerRoutes = [...fenceReads, ...brokerMutations]

const mutationRoutes = [
  '/v1/admin/drain',
  '/v1/admin/evacuate',
  '/v1/admin/migration-complete',
  '/v1/admin/migration-supersede-cell',
  '/v1/admin/rebalance-dormant',
  '/v1/admin/admission-selector/apply',
  '/v1/admin/admission-selector/apply-staging-asia-proof',
  '/v1/admin/admission-selector/add-migration-cells',
  '/v1/admin/cell-state',
  '/v1/admin/cell-admit-mode',
  '/v1/admin/cell-fence-adopt-legacy',
  '/v1/admin/cell-fence-commit-legacy-adoption',
  '/v1/admin/cell-fence-attest',
  '/v1/admin/cell-fence-attempt-prepare',
  '/v1/admin/cell-fence-attempt-start',
  '/v1/admin/cell-fence-attempt-plan',
  '/v1/admin/cell-fence-attempt-operation',
  '/v1/admin/cell-fence-attempt-abort',
  '/v1/admin/drain-attempt-prepare',
  '/v1/admin/drain-attempt-send',
  '/v1/admin/drain-attempt-receipt',
  '/v1/admin/drain-attempt-recover-forward',
  '/v1/admin/cell-config',
  '/v1/admin/evacuate-cell',
  '/v1/admin/cell-heartbeat',
  '/v1/admin/regional-rehome-control',
  '/v1/admin/regional-rehome-trust-probe'
] as const

describe('Relay admin route authorization', () => {
  it('allows the staging capacity identity only its transition routes', () => {
    for (const route of capacityRoutes) {
      expect(relayAdminIdentityMayAccess('capacity', route)).toBe(true)
    }
    for (const route of mutationRoutes) {
      if (capacityRoutes.includes(route)) {
        continue
      }
      expect(relayAdminIdentityMayAccess('capacity', route)).toBe(false)
    }
    expect(relayAdminIdentityMayAccess('capacity', '/v1/admin/evacuation-status')).toBe(false)
  })

  it('allows the Asia proof identity only its selector and status routes', () => {
    for (const route of asiaProofRoutes) {
      expect(relayAdminIdentityMayAccess('asia-proof', route)).toBe(true)
    }
    expect(relayAdminIdentityMayAccess('asia-proof', '/v1/admin/drain')).toBe(false)
    expect(relayAdminIdentityMayAccess('asia-proof', '/v1/admin/cell-state')).toBe(false)
    expect(relayAdminIdentityMayAccess('asia-proof', '/v1/admin/admission-selector/apply')).toBe(false)
    expect(relayAdminIdentityMayAccess('asia-proof', '/v1/admin/admission-selector/add-migration-cells')).toBe(false)
  })

  it('keeps the monitor identity on exact aggregate read routes', () => {
    for (const route of monitorReads) {
      expect(relayAdminIdentityMayAccess('monitor', route)).toBe(true)
    }
    for (const route of [...mutationRoutes, ...fenceReads]) {
      if (monitorReads.includes(route)) {
        continue
      }
      expect(relayAdminIdentityMayAccess('monitor', route)).toBe(false)
    }
    // Read-only on-call lookup: monitor and fence read it, capacity and asia-proof do not.
    for (const identity of ['monitor', 'fence', 'fence-broker', 'deploy'] as const) {
      expect(relayAdminIdentityMayAccess(identity, '/v1/admin/host-whereabouts')).toBe(true)
    }
    for (const identity of ['capacity', 'asia-proof'] as const) {
      expect(relayAdminIdentityMayAccess(identity, '/v1/admin/host-whereabouts')).toBe(false)
    }
  })

  it('keeps the fence identity on aggregate and fence inspection reads', () => {
    for (const route of fenceReads) {
      expect(relayAdminIdentityMayAccess('fence', route)).toBe(true)
    }
    for (const route of mutationRoutes) {
      if (fenceReads.includes(route)) {
        continue
      }
      expect(relayAdminIdentityMayAccess('fence', route)).toBe(false)
    }
  })

  it('allows the broker only exact fence inspection and mutation routes', () => {
    for (const route of brokerRoutes) {
      expect(relayAdminIdentityMayAccess('fence-broker', route)).toBe(true)
    }
    for (const route of [...mutationRoutes, ...fenceReads]) {
      if (brokerRoutes.includes(route)) {
        continue
      }
      expect(relayAdminIdentityMayAccess('fence-broker', route)).toBe(false)
    }
  })

  it('rejects unknown routes for dedicated identities', () => {
    for (const identity of ['capacity', 'asia-proof', 'monitor', 'fence', 'fence-broker'] as const) {
      expect(relayAdminIdentityMayAccess(identity, '/v1/admin/future-mutation')).toBe(false)
      expect(relayAdminIdentityMayAccess(identity, '/health')).toBe(false)
    }
  })
})
