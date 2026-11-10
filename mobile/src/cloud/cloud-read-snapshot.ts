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
  CloudRequestError,
  cloudRequest,
  type CloudControlPlane
} from './cloud-control-plane-request'
import { loadCloudDeviceIdentity } from './cloud-device-identity'
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

const inflight = new Map<string, Promise<{ keyId: string; secretKey: Uint8Array }>>()

/**
 * This phone's reader key, registered with the control plane (PUT /v1/reader-keys) when it never
 * was, when the last registration is over 6 h old, or when `force` is set. Null before enrollment.
 */
export async function ensureCloudReaderKey(
  plane: CloudControlPlane,
  options: { force?: boolean; now?: () => number } = {}
): Promise<{ keyId: string; secretKey: Uint8Array } | null> {
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
      return { keyId: registered.keyId, secretKey: key.secretKey }
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
    return { keyId, secretKey: key.secretKey }
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

const NOT_FOUND_STATES = new Set(['no_snapshot', 'not_sealed_for_key', 'not_found'])
type MissingState = 'no_snapshot' | 'not_sealed_for_key' | 'not_found'

function missingState(error: unknown): MissingState | null {
  return error instanceof CloudRequestError &&
    error.status === 404 &&
    NOT_FOUND_STATES.has(error.code)
    ? (error.code as MissingState)
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
    // The AAD binds exactly the sandbox row id this phone asked for.
    const snapshot = await openReadSnapshot(
      sealed,
      sandboxId,
      reader.secretKey,
      CLOUD_SEALED_PRIMITIVES
    )
    return { state: 'ready', snapshot }
  } catch (error) {
    const missing = missingState(error)
    if (missing === 'not_sealed_for_key') {
      // The key may have been revoked or pruned: renewing it now gets it into the next sleep.
      void ensureCloudReaderKey(plane, { force: true, now }).catch(() => undefined)
    }
    return missing ? { state: missing } : { state: 'error', error }
  }
}
