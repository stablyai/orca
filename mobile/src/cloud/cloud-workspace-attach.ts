import { parsePairingCode } from '../pairing/pairing'
import { startPreProfilePairing } from '../pairing/pre-profile-pairing-coordinator'
import { updateHostNameAndEndpoint } from '../host-catalog/host-store'
import { cloudWorkspaceHostId, recordCloudWorkspaceHost } from './cloud-workspace-links'
import { requestCloudWorkspaceGrant } from './cloud-control-plane-access'
import { wakeCloudWorkspace } from './cloud-control-plane-client'
import { CloudRequestError, type CloudControlPlane } from './cloud-control-plane-request'
import { encodeBase64Bytes } from '../transport/encryption/base64-byte-codec'
import { loadCloudDeviceIdentity } from './cloud-device-identity'
import {
  recordCloudReadSignerFromGrant,
  repinCloudReadSignerAfterPairing
} from './cloud-read-snapshot-pins'
import { createGrantRecipientKey, openCloudSealedGrant } from './cloud-sealed-grant'

// Opening a cloud workspace from the phone: wake the VM through the control plane, then talk to its
// orcad directly as an ordinary paired host (stable wss endpoint, this phone's own device). The
// first open asks the VM for a sealed per-device grant; later opens reuse the saved host.

export type CloudAttachPhase = 'waking' | 'granting' | 'pairing' | 'connected'

export class CloudAttachError extends Error {
  constructor(
    readonly code:
      | 'archived'
      | 'failed'
      | 'not_found'
      | 'wake_timeout'
      | 'wake_failed'
      | 'grant_failed'
      | 'pairing_failed'
  ) {
    super(code)
    this.name = 'CloudAttachError'
  }
}

const WAKE_DEADLINE_MS = 3 * 60_000
const WAKE_RETRY_MS = 1_500

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Long-polls the wake route until the VM is ready; each call holds up to 30 s on the server. */
export async function wakeCloudWorkspaceUntilReady(
  plane: CloudControlPlane,
  sandboxId: string,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + WAKE_DEADLINE_MS
  while (Date.now() < deadline && !signal?.aborted) {
    const startedAt = Date.now()
    const { state } = await wakeCloudWorkspace(plane, sandboxId, signal)
    if (state === 'ready') {
      return
    }
    if (state === 'archived' || state === 'failed' || state === 'not_found') {
      throw new CloudAttachError(state)
    }
    // A server that answers `waking` without holding the request must not be hammered.
    if (Date.now() - startedAt < WAKE_RETRY_MS) {
      await pause(WAKE_RETRY_MS, signal)
    }
  }
  throw new CloudAttachError('wake_timeout')
}

export async function attachCloudWorkspace(args: {
  plane: CloudControlPlane
  sandboxId: string
  title: string
  deviceLabel: string
  onPhase: (phase: CloudAttachPhase) => void
  signal?: AbortSignal
  /**
   * Pair afresh through a new grant even if a host is saved: the saved one was refused (its orcad
   * identity changed) or the workspace's snapshot signer changed, both signs of a rebuilt sandbox.
   * The saved host is only replaced once the new pairing succeeds.
   */
  freshPairing?: boolean
}): Promise<{ hostId: string; paired: boolean; replacedHostId?: string }> {
  args.onPhase('waking')
  try {
    await wakeCloudWorkspaceUntilReady(args.plane, args.sandboxId, args.signal)
  } catch (error) {
    // The control plane failing the wake itself (an unknown 5xx) reads as "couldn't wake".
    if (error instanceof CloudRequestError && error.status >= 500) {
      throw new CloudAttachError('wake_failed')
    }
    throw error
  }
  const existing = await cloudWorkspaceHostId(args.sandboxId)
  if (existing && !args.freshPairing) {
    args.onPhase('connected')
    return { hostId: existing, paired: false }
  }
  args.onPhase('granting')
  const recipient = createGrantRecipientKey()
  let pairingUrl: string
  // The grant's read-snapshot signer, held until this grant's pairing proves it (see below).
  let grantSigner: { sessionId: string; publicKeyB64: string } | null = null
  try {
    const grant = await requestCloudWorkspaceGrant(args.plane, args.sandboxId, {
      recipientPublicKeyB64: encodeBase64Bytes(recipient.publicKey),
      deviceLabel: args.deviceLabel
    })
    const opened = await openCloudSealedGrant(grant.sealed, grant.grantId, recipient.secretKey)
    pairingUrl = opened.pairingUrl
    // The grant names the workspace's read-snapshot signer. On its own (relayed by the control
    // plane) it only fills an empty pin; it never replaces one.
    if (opened.readSignerPublicKeyB64) {
      const sessionId = (await loadCloudDeviceIdentity()).enrollment?.deviceSessionId
      if (sessionId) {
        grantSigner = { sessionId, publicKeyB64: opened.readSignerPublicKeyB64 }
        await recordCloudReadSignerFromGrant(
          sessionId,
          args.sandboxId,
          opened.readSignerPublicKeyB64
        ).catch(() => undefined)
      }
    }
  } catch (error) {
    if (error instanceof CloudRequestError && error.status === 401) {
      throw error
    }
    throw new CloudAttachError('grant_failed')
  } finally {
    recipient.secretKey.fill(0)
  }
  const offer = parsePairingCode(pairingUrl)
  if (!offer) {
    throw new CloudAttachError('grant_failed')
  }
  if (args.signal?.aborted) {
    throw new CloudAttachError('wake_timeout')
  }
  args.onPhase('pairing')
  const attempt = startPreProfilePairing({ offer, timeoutMs: 30_000 })
  const disposeOnAbort = () => attempt.dispose()
  args.signal?.addEventListener('abort', disposeOnAbort)
  try {
    const { hostId } = await attempt.result
    // This grant's offer just completed the end-to-end encrypted pairing with the workspace's
    // orcad: now its signer may replace a pinned one (a rebuilt sandbox). The floor stays.
    if (grantSigner) {
      await repinCloudReadSignerAfterPairing(
        grantSigner.sessionId,
        args.sandboxId,
        grantSigner.publicKeyB64
      ).catch(() => undefined)
    }
    await recordCloudWorkspaceHost(args.sandboxId, hostId)
    await updateHostNameAndEndpoint(hostId, { personalName: args.title }).catch(() => undefined)
    args.onPhase('connected')
    return {
      hostId,
      paired: true,
      ...(existing && existing !== hostId ? { replacedHostId: existing } : {})
    }
  } catch {
    throw new CloudAttachError('pairing_failed')
  } finally {
    args.signal?.removeEventListener('abort', disposeOnAbort)
    attempt.dispose()
  }
}
