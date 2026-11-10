// Reads a sleeping Orca Cloud workspace from the sealed snapshot it left on the control plane,
// without waking the VM. This device's reader key is registered with the control plane (on start,
// after a sign-in or account switch, and at most every 6 h after); the VM seals each snapshot to
// the reader keys registered when it went to sleep.
import { hostname } from 'node:os'
import { openReadSnapshot, ReadSnapshotError } from '../../shared/cloud-workspaces/read-snapshot'
import type { CloudReadSnapshotState } from '../../shared/cloud-workspaces/read-snapshot-state'
import { CloudWorkspacesError, type CloudWorkspacesClient } from './cloud-workspaces-client'
import type { CloudReaderKey, ReaderKeyLoad } from './cloud-reader-key-store'
import { nodeSealedGrantPrimitives } from './sealed-grant-node'

export const READER_KEY_REFRESH_MS = 6 * 60 * 60_000

export type ReaderKeyAccess = {
  /** Who is asking (profile, user, account); null when signed out. Registrations are per identity. */
  identity: () => string | null
  /** This profile's key (created on first use), or why there can be none. */
  load: () => ReaderKeyLoad
  /** The key only if one already exists (sign-out must not create one just to delete it). */
  peek?: () => CloudReaderKey | null
}

type Registration = { identity: string; publicKeyB64: string; keyId: string; at: number }
type Ready = { key: CloudReaderKey; keyId: string; fresh: boolean; identity: string }
type Unavailable = { unavailable: Extract<ReaderKeyLoad, { ok: false }> }

export function createReadSnapshotReader(deps: {
  client: Pick<CloudWorkspacesClient, 'registerReaderKey' | 'getReadSnapshot' | 'deleteReaderKey'>
  readerKey: ReaderKeyAccess
  deviceLabel?: () => string
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  let registration: Registration | null = null
  let inflight: { tag: string; promise: Promise<Registration> } | null = null
  // Highest payload capturedAt opened per (profile/user/account, workspace). Memory only: a
  // restart forgets it, but within a run a replayed older snapshot is refused.
  const newestShown = new Map<string, number>()

  async function ensure(force = false): Promise<Ready | Unavailable> {
    const identity = deps.readerKey.identity()
    if (!identity) {
      throw new CloudWorkspacesError(401, 'unauthorized')
    }
    const loaded = deps.readerKey.load()
    if (!loaded.ok) {
      return { unavailable: loaded }
    }
    const { key } = loaded
    const known = registration
    if (
      !force &&
      known &&
      known.identity === identity &&
      known.publicKeyB64 === key.publicKeyB64 &&
      now() - known.at < READER_KEY_REFRESH_MS
    ) {
      return { key, keyId: known.keyId, fresh: false, identity }
    }
    // Concurrent reads (and the start-up registration) share one PUT per identity and key.
    const tag = `${identity}\0${key.publicKeyB64}`
    let shared = !force && inflight?.tag === tag ? inflight : null
    if (!shared) {
      const promise = deps.client
        .registerReaderKey({
          publicKeyB64: key.publicKeyB64,
          deviceLabel: (deps.deviceLabel?.() ?? hostname()).slice(0, 80) || 'Desktop',
          deviceKind: 'desktop'
        })
        .then((readerKey) => {
          const next = {
            identity,
            publicKeyB64: key.publicKeyB64,
            keyId: readerKey.id,
            at: now()
          }
          // A sign-out or account switch while this was in flight must not adopt the old id.
          if (deps.readerKey.identity() === identity) {
            registration = next
          }
          return next
        })
      const entry = { tag, promise }
      shared = entry
      inflight = entry
      void promise
        .catch(() => undefined)
        .finally(() => {
          if (inflight === entry) {
            inflight = null
          }
        })
    }
    const done = await shared.promise
    return { key, keyId: done.keyId, fresh: true, identity }
  }

  async function fetchWith(sandboxId: string, ready: Ready) {
    try {
      return await deps.client.getReadSnapshot(sandboxId, ready.keyId)
    } catch (error) {
      // A remembered id the server no longer accepts: register again (a revoked key gets a new id).
      if (
        !ready.fresh &&
        error instanceof CloudWorkspacesError &&
        error.status === 400 &&
        error.code === 'invalid_request'
      ) {
        const again = await ensure(true)
        if ('unavailable' in again) {
          throw error
        }
        return { ready: again, fetched: await deps.client.getReadSnapshot(sandboxId, again.keyId) }
      }
      throw error
    }
  }

  return {
    /** Best effort: make sure the control plane knows this device's key before workspaces sleep. */
    async register(): Promise<void> {
      await ensure().catch(() => undefined)
    },

    /**
     * Sign-out: revoke this device's key server-side so no later sleep seals to it. Learns the id
     * (idempotent PUT) when this run never registered. Throws on failure; callers bound and ignore.
     */
    async revoke(timeoutMs: number): Promise<void> {
      const identity = deps.readerKey.identity()
      const key = deps.readerKey.peek?.() ?? null
      if (!identity || !key) {
        return
      }
      const known = registration
      const keyId =
        known && known.identity === identity && known.publicKeyB64 === key.publicKeyB64
          ? known.keyId
          : (
              await deps.client.registerReaderKey({
                publicKeyB64: key.publicKeyB64,
                deviceLabel: (deps.deviceLabel?.() ?? hostname()).slice(0, 80) || 'Desktop',
                deviceKind: 'desktop'
              })
            ).id
      registration = null
      await deps.client.deleteReaderKey(keyId, timeoutMs)
    },

    async read(sandboxId: string): Promise<CloudReadSnapshotState> {
      const first = await ensure()
      if ('unavailable' in first) {
        return {
          state: 'unavailable',
          reason: first.unavailable.reason,
          message: first.unavailable.message
        }
      }
      let ready = first
      const answer = await fetchWith(sandboxId, ready)
      const fetched = 'ready' in answer ? answer.fetched : answer
      if ('ready' in answer) {
        ready = answer.ready
      }
      // not_sealed_for_key only means the snapshot predates this key: report it, never re-register.
      if (fetched.kind !== 'sealed') {
        return { state: fetched.kind }
      }
      try {
        const snapshot = await openReadSnapshot(
          fetched.sealed,
          sandboxId,
          ready.key.secretKey,
          nodeSealedGrantPrimitives
        )
        // Rollback pin: never show a copy older than one already shown for this workspace here.
        const pinKey = `${first.identity}\0${sandboxId}`
        const pinned = newestShown.get(pinKey)
        if (pinned !== undefined && snapshot.capturedAt < pinned) {
          return { state: 'stale' }
        }
        newestShown.set(pinKey, snapshot.capturedAt)
        return { state: 'ready', snapshot, storedAt: fetched.sealed.storedAt }
      } catch (error) {
        if (error instanceof ReadSnapshotError) {
          throw new CloudWorkspacesError(0, 'snapshot_unreadable', error.code)
        }
        throw error
      }
    }
  }
}

export type ReadSnapshotReader = ReturnType<typeof createReadSnapshotReader>
