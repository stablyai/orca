import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { testState, createStore } from './persistence-test-harness'
import {
  MAX_SSH_PENDING_PTY_KILLS_PER_TARGET,
  SSH_PENDING_PTY_KILL_TTL_MS
} from '../shared/ssh-pending-pty-kill'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const NOW = 1_800_000_000_000

describe('Store SSH pending PTY kills', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // The whole point of the record: a laptop closed mid-failure must not lose the kill order.
  it('survives an app restart', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId: 'pty-1', state: 'attached' })
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-1', {
      requestedAt: NOW,
      incarnationId: 'inc-a',
      attempts: 0
    })
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getSshRemotePtyKillIntents('ssh-1', NOW)).toEqual([
      { ptyId: 'pty-1', intent: { requestedAt: NOW, incarnationId: 'inc-a', attempts: 0 } }
    ])
  })

  // A kill issued while the provider was already unregistered writes no lease of its own, and that
  // offline close is the case most likely to strand a remote shell.
  it('records an intent for a PTY that has no lease row yet', async () => {
    const store = await createStore()
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-9', {
      requestedAt: NOW,
      incarnationId: 'inc-z',
      attempts: 0
    })
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getSshRemotePtyKillIntents('ssh-1', NOW).map((e) => e.ptyId)).toEqual(['pty-9'])
  })

  // The row it invents must not be reattachable: the user closed this PTY, and reattach fences only
  // on paneKey/tabId — neither of which a row created here carries.
  it('creates the missing lease terminated so reattach cannot adopt it', async () => {
    const store = await createStore()
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-9', {
      requestedAt: NOW,
      incarnationId: 'inc-z',
      attempts: 0
    })

    const lease = store.getSshRemotePtyLeases('ssh-1')[0]
    expect(lease?.state).toBe('terminated')
    expect(lease?.tabId).toBeUndefined()
    expect(lease?.leafId).toBeUndefined()
  })

  it('deletes expired intents durably rather than only filtering them on read', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId: 'pty-1', state: 'attached' })
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-1', {
      requestedAt: NOW,
      incarnationId: 'inc-a',
      attempts: 0
    })
    store.pruneExpiredSshRemotePtyKillIntents('ssh-1', NOW + SSH_PENDING_PTY_KILL_TTL_MS + 1)
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getSshRemotePtyLeases('ssh-1')[0]?.pendingKill).toBeUndefined()
    // Ageing out observes nothing about the process, so the lease state is left exactly as it was.
    expect(reloaded.getSshRemotePtyLeases('ssh-1')[0]?.state).toBe('attached')
  })

  it('leaves an intent that is still inside its TTL alone', async () => {
    const store = await createStore()
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-1', {
      requestedAt: NOW,
      incarnationId: 'inc-a',
      attempts: 0
    })
    store.pruneExpiredSshRemotePtyKillIntents('ssh-1', NOW + SSH_PENDING_PTY_KILL_TTL_MS)

    expect(store.getSshRemotePtyKillIntents('ssh-1', NOW)).toHaveLength(1)
  })

  // The replay reads every lease state on purpose: the close path tombstones the lease locally and
  // the remote process is still running, so a terminated lease is exactly where an order lives.
  it('keeps an intent on a lease its own kill path tombstoned as terminated', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId: 'pty-1', state: 'attached' })
    store.markSshRemotePtyLease('ssh-1', 'pty-1', 'terminated')
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-1', {
      requestedAt: NOW,
      incarnationId: 'inc-a',
      attempts: 0
    })

    expect(store.getSshRemotePtyKillIntents('ssh-1', NOW)).toHaveLength(1)
  })

  it('retires an intent without touching the lease state', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId: 'pty-1', state: 'attached' })
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-1', {
      requestedAt: NOW,
      incarnationId: 'inc-a',
      attempts: 0
    })
    store.clearSshRemotePtyKillIntent('ssh-1', 'pty-1')
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getSshRemotePtyKillIntents('ssh-1', NOW)).toEqual([])
    expect(reloaded.getSshRemotePtyLeases('ssh-1')[0]?.state).toBe('attached')
  })

  it('drops intents past the TTL on read', async () => {
    const store = await createStore()
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-1', {
      requestedAt: NOW,
      incarnationId: 'inc-a',
      attempts: 0
    })
    expect(
      store.getSshRemotePtyKillIntents('ssh-1', NOW + SSH_PENDING_PTY_KILL_TTL_MS)
    ).toHaveLength(1)
    expect(
      store.getSshRemotePtyKillIntents('ssh-1', NOW + SSH_PENDING_PTY_KILL_TTL_MS + 1)
    ).toEqual([])
  })

  it('caps pending kills per target so an unreachable host cannot grow the store', async () => {
    const store = await createStore()
    const total = MAX_SSH_PENDING_PTY_KILLS_PER_TARGET + 50
    for (let index = 0; index < total; index++) {
      store.recordSshRemotePtyKillIntent('ssh-1', `pty-${index}`, {
        requestedAt: NOW + index,
        incarnationId: `inc-${index}`,
        attempts: 0
      })
    }
    store.flush()

    const reloaded = await createStore()
    const persisted = reloaded
      .getSshRemotePtyLeases('ssh-1')
      .filter((lease) => lease.pendingKill !== undefined)
    expect(persisted).toHaveLength(MAX_SSH_PENDING_PTY_KILLS_PER_TARGET)
    expect(reloaded.getSshRemotePtyLeases('ssh-1')).toHaveLength(
      MAX_SSH_PENDING_PTY_KILLS_PER_TARGET
    )
    // Newest kept: the oldest orders are the ones least likely to still name a live process.
    expect(persisted.some((lease) => lease.ptyId === `pty-${total - 1}`)).toBe(true)
    expect(persisted.some((lease) => lease.ptyId === 'pty-0')).toBe(false)
  })

  it('does not let a repeated close extend the TTL, and carries attempts forward', async () => {
    const store = await createStore()
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-1', {
      requestedAt: NOW,
      incarnationId: 'inc-a',
      attempts: 0
    })
    store.noteSshRemotePtyKillReplayAttempt('ssh-1', 'pty-1')
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-1', {
      requestedAt: NOW + 5000,
      incarnationId: 'inc-a',
      attempts: 0
    })

    expect(store.getSshRemotePtyKillIntents('ssh-1', NOW)[0]?.intent).toEqual({
      requestedAt: NOW,
      incarnationId: 'inc-a',
      attempts: 1
    })
  })

  it('starts a fresh TTL and attempt count when a relay id names a new incarnation', async () => {
    const store = await createStore()
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-1', {
      requestedAt: NOW,
      incarnationId: 'inc-a',
      attempts: 0
    })
    store.noteSshRemotePtyKillReplayAttempt('ssh-1', 'pty-1')
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-1', {
      requestedAt: NOW + 5000,
      incarnationId: 'inc-b',
      attempts: 0
    })

    expect(store.getSshRemotePtyKillIntents('ssh-1', NOW)[0]?.intent).toEqual({
      requestedAt: NOW + 5000,
      incarnationId: 'inc-b',
      attempts: 0
    })
  })

  it('removes a synthetic lease when its only pending intent expires', async () => {
    const store = await createStore()
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-1', {
      requestedAt: NOW,
      incarnationId: 'inc-a',
      attempts: 0
    })

    store.pruneExpiredSshRemotePtyKillIntents('ssh-1', NOW + SSH_PENDING_PTY_KILL_TTL_MS + 1)

    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([])
  })

  it('scopes intents to their own target', async () => {
    const store = await createStore()
    store.recordSshRemotePtyKillIntent('ssh-1', 'pty-1', {
      requestedAt: NOW,
      incarnationId: 'inc-a',
      attempts: 0
    })
    expect(store.getSshRemotePtyKillIntents('ssh-2', NOW)).toEqual([])
  })
})
