import { describe, expect, it, vi } from 'vitest'
import {
  createCloudPairingRecovery,
  isPairingRejection,
  RECOVERY_RETRY_DELAYS_MS,
  type CloudPairingRecoveryDeps,
  type CloudPairingRepair
} from './cloud-pairing-recovery'

const REJECTED = 'Remote Orca runtime rejected the pairing token.'

function deps(overrides: Partial<CloudPairingRecoveryDeps> = {}) {
  const recorded = new Map<string, string>()
  let clock = 1_000
  const base: CloudPairingRecoveryDeps = {
    target: async () => ({ sandboxId: 'sbx_1', kind: 'owned', grantId: null }),
    revision: () => 1,
    openGrant: vi.fn(async () => ({
      ok: true as const,
      value: { grantId: 'grt_new', pairingCode: 'orca://pair?code=fresh' }
    })),
    repair: vi.fn(async (): Promise<CloudPairingRepair> => 'saved'),
    bind: vi.fn(async () => undefined),
    revokeGrant: vi.fn(async () => undefined),
    invalidate: vi.fn(),
    onAccessLost: vi.fn(),
    recordedGrant: vi.fn(async (sandboxId: string) => recorded.get(sandboxId) ?? null),
    recordGrant: vi.fn(async (sandboxId: string, grantId: string | null) => {
      if (grantId) {
        recorded.set(sandboxId, grantId)
      } else {
        recorded.delete(sandboxId)
      }
    }),
    now: () => clock
  }
  return {
    d: { ...base, ...overrides },
    recorded,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

const transient = () =>
  vi.fn(async () => ({ ok: false as const, status: 503, error: 'unavailable' }))

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
    const { d } = deps()
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
    const { d } = deps({
      target: async () => ({ sandboxId: 'sbx_1', kind: 'paired', grantId: 'grt_old' })
    })
    expect(await createCloudPairingRecovery(d).recover('env-1')).toBe('repaired')
    expect(d.bind).toHaveBeenCalledWith('sbx_1', 'env-1', 'grt_new')
    expect(d.revokeGrant).toHaveBeenCalledWith('sbx_1', 'grt_old')
  })

  it('an ex-member (no access any more) is refused: no new pairing, the window is told, never retried', async () => {
    const { d, advance } = deps({
      openGrant: vi.fn(async () => ({ ok: false as const, status: 404, error: 'not_found' }))
    })
    const recovery = createCloudPairingRecovery(d)
    expect(await recovery.recover('env-1')).toBe('access_lost')
    expect(d.repair).not.toHaveBeenCalled()
    expect(d.onAccessLost).toHaveBeenCalledWith('env-1', 'sbx_1')
    advance(10 * 60_000)
    expect(await recovery.recover('env-1')).toBe('already_tried')
    expect(d.openGrant).toHaveBeenCalledTimes(1)
  })

  it('a new pairing (after a repair) may be recovered once more', async () => {
    let revision = 1
    const { d } = deps({ revision: () => revision })
    const recovery = createCloudPairingRecovery(d)
    expect(await recovery.recover('env-1')).toBe('repaired')
    expect(await recovery.recover('env-1')).toBe('already_tried')
    revision = 2
    expect(await recovery.recover('env-1')).toBe('repaired')
    expect(d.openGrant).toHaveBeenCalledTimes(2)
  })

  it('leaves non-cloud servers alone, and drops a fresh grant that cannot repair this server', async () => {
    const notCloud = deps({ target: async () => null }).d
    expect(await createCloudPairingRecovery(notCloud).recover('env-1')).toBe('not_cloud')
    expect(notCloud.openGrant).not.toHaveBeenCalled()

    const failedSwap = deps({ repair: vi.fn(async (): Promise<CloudPairingRepair> => 'failed') }).d
    expect(await createCloudPairingRecovery(failedSwap).recover('env-1')).toBe('retry_later')
    expect(failedSwap.revokeGrant).toHaveBeenCalledWith('sbx_1', 'grt_new')
  })

  it('a repair that throws (network failure in the exchange) still revokes the fresh grant', async () => {
    const { d } = deps({
      repair: vi.fn(async () => {
        throw new Error('exchange failed')
      })
    })
    expect(await createCloudPairingRecovery(d).recover('env-1')).toBe('retry_later')
    expect(d.revokeGrant).toHaveBeenCalledWith('sbx_1', 'grt_new')
    expect(d.invalidate).not.toHaveBeenCalled()
  })
})

describe('grant tracking (GRANT-ID-TRACKING)', () => {
  it('an owned workspace remembers its re-grant, and the next recovery revokes the previous one', async () => {
    let revision = 1
    let next = 'grt_a'
    const { d, recorded } = deps({
      revision: () => revision,
      openGrant: vi.fn(async () => ({
        ok: true as const,
        value: { grantId: next, pairingCode: `orca://pair?code=${next}` }
      }))
    })
    const recovery = createCloudPairingRecovery(d)
    expect(await recovery.recover('env-1')).toBe('repaired')
    expect(recorded.get('sbx_1')).toBe('grt_a')
    expect(d.revokeGrant).not.toHaveBeenCalled()
    revision = 2
    next = 'grt_b'
    expect(await recovery.recover('env-1')).toBe('repaired')
    expect(recorded.get('sbx_1')).toBe('grt_b')
    expect(d.revokeGrant).toHaveBeenCalledWith('sbx_1', 'grt_a')
  })

  it('a bind that fails keeps the new grant tracked here; the old one is revoked; a later good bind clears it', async () => {
    let bindFails = true
    let revision = 1
    let next = 'grt_new'
    const { d, recorded } = deps({
      revision: () => revision,
      target: async () => ({ sandboxId: 'sbx_1', kind: 'paired', grantId: 'grt_old' }),
      openGrant: vi.fn(async () => ({
        ok: true as const,
        value: { grantId: next, pairingCode: 'orca://pair?code=x' }
      })),
      bind: vi.fn(async () => {
        if (bindFails) {
          throw new Error('disk full')
        }
      })
    })
    const recovery = createCloudPairingRecovery(d)
    expect(await recovery.recover('env-1')).toBe('repaired')
    expect(d.revokeGrant).toHaveBeenCalledWith('sbx_1', 'grt_old')
    expect(d.revokeGrant).not.toHaveBeenCalledWith('sbx_1', 'grt_new')
    expect(recorded.get('sbx_1')).toBe('grt_new')
    // Next time the bind works: the binding tracks the newest grant, and the stray one is revoked.
    bindFails = false
    revision = 2
    next = 'grt_newer'
    expect(await recovery.recover('env-1')).toBe('repaired')
    expect(d.revokeGrant).toHaveBeenCalledWith('sbx_1', 'grt_new')
    expect(recorded.has('sbx_1')).toBe(false)
  })

  it('a transient failure retries after a wait, at most three attempts per pairing', async () => {
    const openGrant = transient()
    const { d, advance } = deps({ openGrant })
    const recovery = createCloudPairingRecovery(d)
    expect(await recovery.recover('env-1')).toBe('retry_later')
    // Too soon: another refusal right away doesn't call the control plane again.
    expect(await recovery.recover('env-1')).toBe('already_tried')
    advance(RECOVERY_RETRY_DELAYS_MS[0])
    expect(await recovery.recover('env-1')).toBe('retry_later')
    advance(RECOVERY_RETRY_DELAYS_MS[1])
    expect(await recovery.recover('env-1')).toBe('failed')
    advance(60 * 60_000)
    expect(await recovery.recover('env-1')).toBe('already_tried')
    expect(openGrant).toHaveBeenCalledTimes(3)
  })

  it('a retry that succeeds repairs as usual', async () => {
    let fail = true
    const { d, advance } = deps({
      openGrant: vi.fn(async () =>
        fail
          ? { ok: false as const, status: 502, error: 'bad_gateway' }
          : { ok: true as const, value: { grantId: 'grt_new', pairingCode: 'orca://pair?code=y' } }
      )
    })
    const recovery = createCloudPairingRecovery(d)
    expect(await recovery.recover('env-1')).toBe('retry_later')
    fail = false
    advance(RECOVERY_RETRY_DELAYS_MS[0])
    expect(await recovery.recover('env-1')).toBe('repaired')
  })

  it('a grant for a different server is final: revoked once, never retried', async () => {
    const { d, advance } = deps({
      repair: vi.fn(async (): Promise<CloudPairingRepair> => 'wrong_server')
    })
    const recovery = createCloudPairingRecovery(d)
    expect(await recovery.recover('env-1')).toBe('failed')
    expect(d.revokeGrant).toHaveBeenCalledWith('sbx_1', 'grt_new')
    advance(60 * 60_000)
    expect(await recovery.recover('env-1')).toBe('already_tried')
    expect(d.openGrant).toHaveBeenCalledTimes(1)
  })

  it('a tracking write that fails keeps the grant tracked for this run, so the next recovery revokes it', async () => {
    let revision = 1
    let next = 'grt_a'
    let writeFails = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { d, recorded } = deps({
      revision: () => revision,
      openGrant: vi.fn(async () => ({
        ok: true as const,
        value: { grantId: next, pairingCode: 'orca://pair?code=z' }
      })),
      recordGrant: vi.fn(async (sandboxId: string, grantId: string | null) => {
        if (writeFails) {
          throw new Error('disk full')
        }
        if (grantId) {
          recorded.set(sandboxId, grantId)
        }
      })
    })
    const recovery = createCloudPairingRecovery(d)
    // The live grant is never revoked just because it couldn't be written down.
    expect(await recovery.recover('env-1')).toBe('repaired')
    expect(d.revokeGrant).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    writeFails = false
    revision = 2
    next = 'grt_b'
    expect(await recovery.recover('env-1')).toBe('repaired')
    expect(d.revokeGrant).toHaveBeenCalledWith('sbx_1', 'grt_a')
    expect(recorded.get('sbx_1')).toBe('grt_b')
    warn.mockRestore()
  })
})
