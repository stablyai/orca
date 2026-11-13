import { describe, expect, it, vi } from 'vitest'
import {
  createCloudPairingRecovery,
  isPairingRejection,
  type CloudPairingRecoveryDeps
} from './cloud-pairing-recovery'

const REJECTED = 'Remote Orca runtime rejected the pairing token.'

function deps(overrides: Partial<CloudPairingRecoveryDeps> = {}) {
  const base: CloudPairingRecoveryDeps = {
    target: async () => ({ sandboxId: 'sbx_1', kind: 'owned', grantId: null }),
    revision: () => 1,
    openGrant: vi.fn(async () => ({
      ok: true as const,
      value: { grantId: 'grt_new', pairingCode: 'orca://pair?code=fresh' }
    })),
    repair: vi.fn(async () => true),
    bind: vi.fn(async () => undefined),
    revokeGrant: vi.fn(async () => undefined),
    invalidate: vi.fn(),
    onAccessLost: vi.fn()
  }
  return { ...base, ...overrides }
}

describe('cloud pairing recovery (EP-8)', () => {
  it('re-grants only on a real refusal of the pairing', () => {
    expect(isPairingRejection('unauthorized', '')).toBe(true)
    expect(isPairingRejection('device_revoked', '')).toBe(true)
    expect(isPairingRejection(undefined, REJECTED)).toBe(true)
    // Timeouts, network failures and other authorization errors never trigger a re-grant.
    expect(isPairingRejection('timeout', 'Request timed out')).toBe(false)
    expect(isPairingRejection('forbidden', 'Not allowed')).toBe(false)
    expect(isPairingRejection(undefined, 'connect ECONNREFUSED')).toBe(false)
  })

  it('a regained owner gets a fresh grant for this computer and reconnects on the same server', async () => {
    const d = deps()
    const recovery = createCloudPairingRecovery(d)
    recovery.noteRejected('env-1', 'unauthorized', REJECTED)
    expect(await recovery.pending('env-1')).toBe('repaired')
    expect(d.openGrant).toHaveBeenCalledWith('sbx_1')
    expect(d.repair).toHaveBeenCalledWith('env-1', 'orca://pair?code=fresh')
    expect(d.invalidate).toHaveBeenCalledWith('env-1')
    // An owned workspace has no binding to update.
    expect(d.bind).not.toHaveBeenCalled()
  })

  it('a paired workspace binds the new grant and revokes the old one', async () => {
    const d = deps({
      target: async () => ({ sandboxId: 'sbx_1', kind: 'paired', grantId: 'grt_old' })
    })
    const recovery = createCloudPairingRecovery(d)
    expect(await recovery.recover('env-1')).toBe('repaired')
    expect(d.bind).toHaveBeenCalledWith('sbx_1', 'env-1', 'grt_new')
    expect(d.revokeGrant).toHaveBeenCalledWith('sbx_1', 'grt_old')
  })

  it('an ex-member (no access any more) is refused: no new pairing, the window is told', async () => {
    const d = deps({
      openGrant: vi.fn(async () => ({ ok: false as const, status: 404, error: 'not_found' }))
    })
    const recovery = createCloudPairingRecovery(d)
    expect(await recovery.recover('env-1')).toBe('access_lost')
    expect(d.repair).not.toHaveBeenCalled()
    expect(d.onAccessLost).toHaveBeenCalledWith('env-1', 'sbx_1')
  })

  it('tries once per saved pairing: a second refusal on the same pairing calls nothing', async () => {
    const d = deps({
      openGrant: vi.fn(async () => ({ ok: false as const, status: 503, error: 'unavailable' }))
    })
    const recovery = createCloudPairingRecovery(d)
    expect(await recovery.recover('env-1')).toBe('failed')
    expect(await recovery.recover('env-1')).toBe('already_tried')
    recovery.noteRejected('env-1', 'unauthorized', REJECTED)
    expect(await recovery.pending('env-1')).toBe('already_tried')
    expect(d.openGrant).toHaveBeenCalledTimes(1)
  })

  it('a new pairing (after a repair) may be recovered once more', async () => {
    let revision = 1
    const d = deps({ revision: () => revision })
    const recovery = createCloudPairingRecovery(d)
    expect(await recovery.recover('env-1')).toBe('repaired')
    revision = 2
    expect(await recovery.recover('env-1')).toBe('repaired')
    expect(d.openGrant).toHaveBeenCalledTimes(2)
  })

  it('leaves non-cloud servers alone, and drops a fresh grant that cannot repair this server', async () => {
    const notCloud = deps({ target: async () => null })
    expect(await createCloudPairingRecovery(notCloud).recover('env-1')).toBe('not_cloud')
    expect(notCloud.openGrant).not.toHaveBeenCalled()

    const wrongServer = deps({ repair: vi.fn(async () => false) })
    expect(await createCloudPairingRecovery(wrongServer).recover('env-1')).toBe('failed')
    expect(wrongServer.revokeGrant).toHaveBeenCalledWith('sbx_1', 'grt_new')
  })

  it('a repair that throws (network failure in the exchange) still revokes the fresh grant', async () => {
    const d = deps({
      repair: vi.fn(async () => {
        throw new Error('exchange failed')
      })
    })
    expect(await createCloudPairingRecovery(d).recover('env-1')).toBe('failed')
    expect(d.revokeGrant).toHaveBeenCalledWith('sbx_1', 'grt_new')
    expect(d.invalidate).not.toHaveBeenCalled()
  })

  it('a bind that throws after a saved repair still revokes the old grant and reconnects', async () => {
    const d = deps({
      target: async () => ({ sandboxId: 'sbx_1', kind: 'paired', grantId: 'grt_old' }),
      bind: vi.fn(async () => {
        throw new Error('disk full')
      })
    })
    expect(await createCloudPairingRecovery(d).recover('env-1')).toBe('repaired')
    expect(d.revokeGrant).toHaveBeenCalledWith('sbx_1', 'grt_old')
    expect(d.revokeGrant).not.toHaveBeenCalledWith('sbx_1', 'grt_new')
    expect(d.invalidate).toHaveBeenCalledWith('env-1')
  })
})
