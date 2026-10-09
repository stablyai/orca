import nacl from 'tweetnacl'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { loadHosts } from '../transport/host-store'
import { resolveHostIdForFingerprint } from './push-host-fingerprint'

// Why: for phones that opt in, the desktop seals a push's text, worktree, notification
// id and epoch per device so the gateway and FCM only see a generic title. Wire format and rationale live in
// src/main/runtime/push/push-e2e-seal.ts; this is the opening half.
export const SEALED_PUSH_PREFIX = 'e2e1:'
const KEY_LABEL = 'orca-push-e2e-v1'

export type SealedPushEnvelope = { t?: string; b?: string; w?: string; n?: string; e?: string }

export type OpenedPush = {
  /** The push data with the real ids restored and the envelope removed. */
  readonly data: Record<string, unknown>
  readonly title?: string
  readonly body?: string
  readonly opened: boolean
}

export function isSealedPushPaneKey(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SEALED_PUSH_PREFIX)
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

function readEnvelopeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function openSealedPushEnvelope(
  sealed: string,
  deviceToken: string
): SealedPushEnvelope | null {
  const bundle = base64ToBytes(sealed.slice(SEALED_PUSH_PREFIX.length))
  if (!bundle || bundle.length <= nacl.secretbox.nonceLength) {
    return null
  }
  // Hermes can hand back typed arrays that fail tweetnacl's instanceof checks.
  const key = new Uint8Array(hmac(sha256, new TextEncoder().encode(deviceToken), KEY_LABEL))
  const plaintext = nacl.secretbox.open(
    new Uint8Array(bundle.subarray(nacl.secretbox.nonceLength)),
    new Uint8Array(bundle.subarray(0, nacl.secretbox.nonceLength)),
    key
  )
  if (!plaintext) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext))
    if (!isRecord(parsed)) {
      return null
    }
    const record = parsed
    return {
      t: readEnvelopeString(record.t),
      b: typeof record.b === 'string' ? record.b : undefined,
      w: readEnvelopeString(record.w),
      n: readEnvelopeString(record.n),
      e: readEnvelopeString(record.e)
    }
  } catch {
    return null
  }
}

/**
 * Null when the data carries no sealed envelope. An envelope the paired key cannot open
 * is stripped, and the real title, body, worktree and notification id are restored when
 * it opens. If the host store itself fails, the data is kept whole so a later read (a
 * tap, a tray sweep) can still open it; readOrcaPushPayload never routes an e2e1 paneKey.
 */
export async function openSealedPushData(data: unknown): Promise<OpenedPush | null> {
  if (!isRecord(data)) {
    return null
  }
  const { paneKey, ...rest } = data
  if (!isSealedPushPaneKey(paneKey)) {
    return null
  }
  const fingerprint = typeof rest.hostFingerprint === 'string' ? rest.hostFingerprint : ''
  const hosts = await loadHosts().catch(() => null)
  if (!hosts) {
    return { data, opened: false }
  }
  const hostId = resolveHostIdForFingerprint(fingerprint, hosts)
  const host = hostId ? hosts.find((candidate) => candidate.id === hostId) : undefined
  const envelope = host ? openSealedPushEnvelope(paneKey, host.deviceToken) : null
  if (!envelope) {
    return { data: rest, opened: false }
  }
  const title = envelope.t
  const body = envelope.b
  return {
    data: {
      ...rest,
      ...(envelope.n ? { notificationId: envelope.n } : {}),
      ...(envelope.w ? { worktreeId: envelope.w } : {}),
      ...(envelope.e ? { notificationEpoch: envelope.e } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { message: body } : {})
    },
    title,
    body,
    opened: true
  }
}

/** The data every policy check should read: the opened push when sealed, the input otherwise. */
export async function readablePushData(data: unknown): Promise<unknown> {
  const opened = await openSealedPushData(data).catch(() => null)
  return opened ? opened.data : data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
