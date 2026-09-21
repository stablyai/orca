import { describe, expect, it } from 'vitest'
import {
  RELAY_ASIA_PROOF_ADMIN_ROUTES,
  RELAY_CAPACITY_ADMIN_ROUTES,
  RELAY_FENCE_BROKER_ADMIN_ROUTES,
  RELAY_FENCE_ADMIN_ROUTES,
  RELAY_MONITOR_ADMIN_ROUTES,
  relayAdminIdentityMayAccess
} from './admin-token-verifier.js'

const mutationRoutes = [
  '/v1/admin/drain',
  '/v1/admin/evacuate',
  '/v1/admin/migration-complete',
  '/v1/admin/migration-supersede-cell',
  '/v1/admin/rebalance-dormant',
  '/v1/admin/admission-selector/apply',
  '/v1/admin/admission-selector/add-migration-cells',
  '/v1/admin/cell-state',
  '/v1/admin/cell-fence-adopt-legacy',
  '/v1/admin/cell-fence-commit-legacy-adoption',
  '/v1/admin/cell-fence-attest',
  '/v1/admin/cell-fence-attempt-prepare',
  '/v1/admin/cell-fence-attempt-start',
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
    for (const route of RELAY_CAPACITY_ADMIN_ROUTES) {
      expect(relayAdminIdentityMayAccess('capacity', route)).toBe(true)
    }
    for (const route of mutationRoutes) {
      if ((RELAY_CAPACITY_ADMIN_ROUTES as readonly string[]).includes(route)) continue
      expect(relayAdminIdentityMayAccess('capacity', route)).toBe(false)
    }
    expect(RELAY_CAPACITY_ADMIN_ROUTES).toContain('/v1/admin/cell-state')
    expect(relayAdminIdentityMayAccess('capacity', '/v1/admin/evacuation-status')).toBe(false)
  })

  it('allows the Asia proof identity only its selector and status routes', () => {
    for (const route of RELAY_ASIA_PROOF_ADMIN_ROUTES) {
      expect(relayAdminIdentityMayAccess('asia-proof', route)).toBe(true)
    }
    expect(relayAdminIdentityMayAccess('asia-proof', '/v1/admin/drain')).toBe(false)
    expect(relayAdminIdentityMayAccess('asia-proof', '/v1/admin/cell-state')).toBe(false)
    expect(relayAdminIdentityMayAccess('asia-proof', '/v1/admin/admission-selector/apply')).toBe(false)
    expect(relayAdminIdentityMayAccess('asia-proof', '/v1/admin/add-migration-cells')).toBe(false)
  })

  it('keeps the monitor identity on exact aggregate read routes', () => {
    for (const route of RELAY_MONITOR_ADMIN_ROUTES) {
      expect(relayAdminIdentityMayAccess('monitor', route)).toBe(true)
    }
    for (const route of [...mutationRoutes, ...RELAY_FENCE_ADMIN_ROUTES]) {
      if ((RELAY_MONITOR_ADMIN_ROUTES as readonly string[]).includes(route)) continue
      expect(relayAdminIdentityMayAccess('monitor', route)).toBe(false)
    }
    expect(RELAY_MONITOR_ADMIN_ROUTES).toContain('/v1/admin/evacuation-status')
  })

  it('allows only reviewed fence evidence mutations beyond aggregate reads', () => {
    for (const route of RELAY_FENCE_ADMIN_ROUTES) {
      expect(relayAdminIdentityMayAccess('fence', route)).toBe(true)
    }
    for (const route of mutationRoutes) {
      if ((RELAY_FENCE_ADMIN_ROUTES as readonly string[]).includes(route)) continue
      expect(relayAdminIdentityMayAccess('fence', route)).toBe(false)
    }
  })

  it('allows the broker only exact fence inspection and mutation routes', () => {
    for (const route of RELAY_FENCE_BROKER_ADMIN_ROUTES) {
      expect(relayAdminIdentityMayAccess('fence-broker', route)).toBe(true)
    }
    for (const route of [...mutationRoutes, ...RELAY_FENCE_ADMIN_ROUTES]) {
      if ((RELAY_FENCE_BROKER_ADMIN_ROUTES as readonly string[]).includes(route)) continue
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
