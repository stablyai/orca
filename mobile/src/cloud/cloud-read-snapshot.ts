import {
  CloudReadSnapshotResponseSchema,
  CloudReaderKeyResponseSchema
} from '../../../src/shared/cloud-workspaces/cloud-workspaces-wire'
import {
  openReadSnapshot,
  type ReadSnapshot,
  type SealedReadSnapshot
} from '../../../src/shared/cloud-workspaces/read-snapshot'
import {
  checkReadSnapshotPin,
  ReadSnapshotSignatureError,
  verifyReadSnapshotSigner
} from '../../../src/shared/cloud-workspaces/read-snapshot-signature'
import nacl from 'tweetnacl'
import {
  CloudRequestError,
  cloudRequest,
  type CloudControlPlane
} from './cloud-control-plane-request'
import { loadCloudDeviceIdentity } from './cloud-device-identity'
import { commitCloudReadSnapshotPin, loadCloudReadSnapshotPin } from './cloud-read-snapshot-pins'
import { loadCloudReaderKey, saveCloudReaderKeyRegistration } from './cloud-reader-key'
import { CLOUD_SEALED_PRIMITIVES } from './cloud-sealed-grant'

// Reads a sleeping workspace's sealed snapshot without waking it. The control plane relays only
// ciphertext plus this phone's own wrapped key; the reader key's secret opens it on the phone.

/** Re-register at most this often; the control plane bumps lastSeenAt on each. */
export const CLOUD_READER_KEY_REFRESH_MS = 6 * 60 * 60 * 1000

export type CloudReadSnapshotResult =
  | { state: 'ready'; snapshot: ReadSnapshot }
  /** Nothing captured yet: it is captured each time the workspace goes to sleep. */
  | { state: 'no_snapshot' }
  /** A snapshot exists, but this phone's key was added (or renewed) after it last slept. */
  | { state: 'not_sealed_for_key' }
  /** Gone, or this phone may no longer open it. */
  | { state: 'not_found' }
  /** Anything else; a 401 here means the session was revoked (see forgetRevokedCloudSession). */
  | { state: 'error'; error: unknown }

type CloudReader = { deviceSessionId: string; keyId: string; secretKey: Uint8Array }

const inflight = new Map<string, Promise<CloudReader>>()

/**
 * This phone's reader key, registered with the control plane (PUT /v1/reader-keys) when it never
 * was, when the last registration is over 6 h old, or when `force` is set. Null before enrollment.
 */
export async function ensureCloudReaderKey(
  plane: CloudControlPlane,
  options: { force?: boolean; now?: () => number } = {}
): Promise<CloudReader | null> {
  const enrollment = (await loadCloudDeviceIdentity()).enrollment
  if (!enrollment) {
    return null
  }
  const now = options.now ?? Date.now
  const sessionId = enrollment.deviceSessionId
  const running = inflight.get(sessionId)
  if (running) {
    return running
  }
  const task = (async () => {
    const key = await loadCloudReaderKey(sessionId)
    const registered = key.registration
    if (
      !options.force &&
      registered &&
      now() - registered.registeredAt < CLOUD_READER_KEY_REFRESH_MS
    ) {
      return { deviceSessionId: sessionId, keyId: registered.keyId, secretKey: key.secretKey }
    }
    const reply = await cloudRequest(
      plane,
      'PUT',
      '/v1/reader-keys',
      CloudReaderKeyResponseSchema,
      {
        body: {
          publicKeyB64: key.publicKeyB64,
          deviceLabel: enrollment.label.trim().slice(0, 80) || 'Orca mobile',
          deviceKind: 'mobile'
        },
        timeoutMs: 15_000
      }
    )
    const keyId = reply.readerKey.id
    await saveCloudReaderKeyRegistration(key, { keyId, registeredAt: now() })
    return { deviceSessionId: sessionId, keyId, secretKey: key.secretKey }
  })()
  inflight.set(sessionId, task)
  try {
    return await task
  } finally {
    inflight.delete(sessionId)
  }
}

async function fetchSealed(
  plane: CloudControlPlane,
  sandboxId: string,
  keyId: string,
  signal?: AbortSignal
): Promise<SealedReadSnapshot> {
  const reply = await cloudRequest(
    plane,
    'GET',
    `/v1/team/workspaces/${encodeURIComponent(sandboxId)}/read-snapshot?keyId=${encodeURIComponent(keyId)}`,
    CloudReadSnapshotResponseSchema,
    { signal, timeoutMs: 20_000 }
  )
  return reply.snapshot
}

/**
 * A copy this phone refuses to show: older than one it already showed (`rollback`), or not signed by
 * the workspace's pinned VM key (`signer_changed`, `unsigned`, `bad_signature`).
 */
export class CloudReadSnapshotRefusedError extends Error {
  constructor(readonly reason: 'rollback' | 'signer_changed' | 'unsigned' | 'bad_signature') {
    super(`read_snapshot_${reason}`)
    this.name = 'CloudReadSnapshotRefusedError'
  }
}

const ed25519Verify = (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) =>
  nacl.sign.detached.verify(message, signature, publicKey)

type MissingState = 'no_snapshot' | 'not_sealed_for_key' | 'not_found'

const isMissingState = (code: string): code is MissingState =>
  code === 'no_snapshot' || code === 'not_sealed_for_key' || code === 'not_found'

function missingState(error: unknown): MissingState | null {
  return error instanceof CloudRequestError && error.status === 404 && isMissingState(error.code)
    ? error.code
    : null
}

/** The sleeping workspace's last snapshot, opened on this phone; never wakes the sandbox. */
export async function readCloudWorkspaceSnapshot(
  plane: CloudControlPlane,
  sandboxId: string,
  options: { signal?: AbortSignal; now?: () => number } = {}
): Promise<CloudReadSnapshotResult> {
  const { signal, now } = options
  try {
    let reader = await ensureCloudReaderKey(plane, { now })
    if (!reader) {
      return { state: 'error', error: new CloudRequestError('not_enrolled', 0) }
    }
    let sealed: SealedReadSnapshot
    try {
      sealed = await fetchSealed(plane, sandboxId, reader.keyId, signal)
    } catch (error) {
      if (
        !(error instanceof CloudRequestError) ||
        error.status !== 400 ||
        error.code !== 'invalid_request'
      ) {
        throw error
      }
      // A key id the control plane no longer takes: register again and ask once more.
      reader = await ensureCloudReaderKey(plane, { force: true, now })
      if (!reader) {
        throw error
      }
      sealed = await fetchSealed(plane, sandboxId, reader.keyId, signal)
    }
    // Who wrote it, before opening anything: a forged signature is refused outright.
    let signer: string | null
    try {
      signer = await verifyReadSnapshotSigner(sealed, ed25519Verify)
    } catch (error) {
      if (error instanceof ReadSnapshotSignatureError) {
        return { state: 'error', error: new CloudReadSnapshotRefusedError('bad_signature') }
      }
      throw error
    }
    // A pinned signer that doesn't match (or a missing signature) is refused before decrypting;
    // only the rollback check needs the payload's capturedAt.
    const pin = await loadCloudReadSnapshotPin(reader.deviceSessionId, sandboxId)
    const early = checkReadSnapshotPin(pin, signer, Number.POSITIVE_INFINITY)
    if (!early.ok) {
      return { state: 'error', error: new CloudReadSnapshotRefusedError(early.reason) }
    }
    // The AAD binds exactly the sandbox row id this phone asked for.
    const snapshot = await openReadSnapshot(
      sealed,
      sandboxId,
      reader.secretKey,
      CLOUD_SEALED_PRIMITIVES
    )
    // Persisted per device session and workspace: pinned signer, never an older capture.
    const verdict = checkReadSnapshotPin(pin, signer, snapshot.capturedAt)
    if (!verdict.ok) {
      return { state: 'error', error: new CloudReadSnapshotRefusedError(verdict.reason) }
    }
    await commitCloudReadSnapshotPin(reader.deviceSessionId, sandboxId, pin, verdict.pin)
    return { state: 'ready', snapshot }
  } catch (error) {
    // not_sealed_for_key only means the snapshot predates this key: nothing to renew here.
    const missing = missingState(error)
    return missing ? { state: missing } : { state: 'error', error }
  }
}
