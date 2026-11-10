// Reads a sleeping Orca Cloud workspace from the sealed snapshot it left on the control plane,
// without waking the VM. This device's reader key is registered with the control plane (on start,
// after a sign-in or account switch, and at most every 6 h after); the VM seals each snapshot to
// the reader keys registered when it went to sleep.
import { hostname } from 'node:os'
import {
  openReadSnapshot,
  ReadSnapshotError,
  type ReadSnapshot
} from '../../shared/cloud-workspaces/read-snapshot'
import type { CloudReadSnapshotState } from '../../shared/cloud-workspaces/read-snapshot-state'
import { CloudWorkspacesError, type CloudWorkspacesClient } from './cloud-workspaces-client'
import type { CloudReaderKey, ReaderKeyLoad } from './cloud-reader-key-store'
import {
  checkReadSnapshotPin,
  pinFromGrant,
  ReadSnapshotSignatureError,
  verifyReadSnapshotSigner,
  type ReadSnapshotPin
} from '../../shared/cloud-workspaces/read-snapshot-signature'
import { ed25519Verify, nodeSealedGrantPrimitives } from './sealed-grant-node'

export const READER_KEY_REFRESH_MS = 6 * 60 * 60_000

export type ReaderKeyAccess = {
  /** Who is asking (profile, user, account); null when signed out. Registrations are per identity. */
  identity: () => string | null
  /** This profile's key (created on first use), or why there can be none. */
  load: () => Promise<ReaderKeyLoad>
  /** The key only if one already exists (sign-out must not create one just to delete it). */
  peek?: () => Promise<CloudReaderKey | null>
}

/** Where the per-workspace signer and rollback pins live (persisted per profile in the app). */
export type ReadPinAccess = {
  get: (identity: string, sandboxId: string) => Promise<ReadSnapshotPin | null>
  set: (identity: string, sandboxId: string, pin: ReadSnapshotPin) => Promise<void>
}

/** In-memory pins (tests, or a build without a profile directory). */
export function memoryReadPins(): ReadPinAccess {
  const pins = new Map<string, ReadSnapshotPin>()
  return {
    get: async (identity, sandboxId) => pins.get(`${identity}\0${sandboxId}`) ?? null,
    set: async (identity, sandboxId, pin) => {
      pins.set(`${identity}\0${sandboxId}`, pin)
    }
  }
}

type Registration = { identity: string; publicKeyB64: string; keyId: string; at: number }
type Ready = { key: CloudReaderKey; keyId: string; fresh: boolean; identity: string }
type Unavailable = { unavailable: Extract<ReaderKeyLoad, { ok: false }> }

export function createReadSnapshotReader(deps: {
  client: Pick<CloudWorkspacesClient, 'registerReaderKey' | 'getReadSnapshot' | 'deleteReaderKey'>
  readerKey: ReaderKeyAccess
  pins?: ReadPinAccess
  deviceLabel?: () => string
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  let registration: Registration | null = null
  let inflight: { tag: string; promise: Promise<Registration> } | null = null
  const pins = deps.pins ?? memoryReadPins()

  async function ensure(force = false): Promise<Ready | Unavailable> {
    const identity = deps.readerKey.identity()
    if (!identity) {
      throw new CloudWorkspacesError(401, 'unauthorized')
    }
    const loaded = await deps.readerKey.load()
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
      const key = (await deps.readerKey.peek?.()) ?? null
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

    /**
     * Pairing (a sealed grant) names the workspace's signer: pin it, replacing any earlier one. This
     * is the trusted way back after the VM's disk (and so its signing key) was replaced.
     */
    async pinSigner(sandboxId: string, signerPublicKeyB64: string): Promise<void> {
      const identity = deps.readerKey.identity()
      if (!identity) {
        return
      }
      await pins.set(
        identity,
        sandboxId,
        pinFromGrant(await pins.get(identity, sandboxId), signerPublicKeyB64)
      )
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
      // Who wrote it, before anything is decrypted: a forged signature is refused outright.
      let signer: string | null
      try {
        signer = await verifyReadSnapshotSigner(fetched.sealed, ed25519Verify)
      } catch (error) {
        if (error instanceof ReadSnapshotSignatureError) {
          return { state: 'unverified', reason: 'bad_signature' }
        }
        throw error
      }
      let snapshot: ReadSnapshot
      try {
        snapshot = await openReadSnapshot(
          fetched.sealed,
          sandboxId,
          ready.key.secretKey,
          nodeSealedGrantPrimitives
        )
      } catch (error) {
        if (error instanceof ReadSnapshotError) {
          throw new CloudWorkspacesError(0, 'snapshot_unreadable', error.code)
        }
        throw error
      }
      // Pins: only the signer this device trusts for the workspace, never an older copy.
      const verdict = checkReadSnapshotPin(
        await pins.get(first.identity, sandboxId),
        signer,
        snapshot.capturedAt
      )
      if (!verdict.ok) {
        return verdict.reason === 'rollback'
          ? { state: 'stale' }
          : { state: 'unverified', reason: verdict.reason }
      }
      await pins.set(first.identity, sandboxId, verdict.pin)
      return { state: 'ready', snapshot, storedAt: fetched.sealed.storedAt }
    }
  }
}

export type ReadSnapshotReader = ReturnType<typeof createReadSnapshotReader>
