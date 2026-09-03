import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, testState } from './persistence-test-harness'
import { sshRemotePtyLeaseAllowsReattach } from '../shared/ssh-types'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

/**
 * `expired` records that the CLIENT lost its route, so a reattach that named the pty and succeeded
 * is the only evidence that can settle which of "orphan" or "corpse" it was. Without the edge back
 * to `attached`, a lease that proved itself alive stayed `expired` for good and every sweep keyed
 * on that state — `ssh:reset`, `ssh:terminateSessions`, the quit-time `detached` mark, supersession
 * — silently skipped a running remote shell.
 */
describe('ssh remote pty lease reclaim after a proven reattach', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('reclaims an expired lease that the relay reattached, clearing its route-retirement marks', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId: 'pty-1', state: 'attached' })
    store.markSshRemotePtyLease('ssh-1', 'pty-1', 'expired')
    // A predecessor mark left over from a supersession this lease has now outlived.
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'pty-1',
      state: 'expired',
      supersededBy: 'pty-2'
    })

    await store.markSshRemotePtyLeasesAttachedAsync('ssh-1', ['pty-1'])

    const [lease] = store.getSshRemotePtyLeases('ssh-1')
    expect(lease).toMatchObject({ ptyId: 'pty-1', state: 'attached' })
    expect(lease).not.toHaveProperty('supersededBy')
    expect(lease).not.toHaveProperty('relayIdRecycled')
    expect(sshRemotePtyLeaseAllowsReattach(lease)).toBe(true)
  })

  it('leaves a terminated lease absorbing even when the id appears in a reattach batch', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId: 'pty-1', state: 'attached' })
    store.markSshRemotePtyLease('ssh-1', 'pty-1', 'terminated')

    await store.markSshRemotePtyLeasesAttachedAsync('ssh-1', ['pty-1'])

    expect(store.getSshRemotePtyLeases('ssh-1')[0]).toMatchObject({ state: 'terminated' })
  })

  it('does not revive an expired lease from an unqualified bulk attach', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId: 'pty-1', state: 'attached' })
    store.markSshRemotePtyLease('ssh-1', 'pty-1', 'expired')

    store.markSshRemotePtyLeases('ssh-1', 'attached')

    // Only the id-qualified caller carries per-pty proof; a target-wide mark does not.
    expect(store.getSshRemotePtyLeases('ssh-1')[0]).toMatchObject({ state: 'expired' })
  })

  it('lets a reclaimed lease be swept as detached at quit', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId: 'pty-1', state: 'attached' })
    store.markSshRemotePtyLease('ssh-1', 'pty-1', 'expired')
    await store.markSshRemotePtyLeasesAttachedAsync('ssh-1', ['pty-1'])

    store.markSshRemotePtyLeases('ssh-1', 'detached')

    expect(store.getSshRemotePtyLeases('ssh-1')[0]).toMatchObject({ state: 'detached' })
  })
})
