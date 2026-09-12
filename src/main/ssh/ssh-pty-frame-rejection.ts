import type { SshPtyDataCallback } from '../providers/ssh-pty-provider-contract'
import type { SshPtyConsumerOwnerState } from './ssh-pty-consumer-session'

type SshPtyDataPayload = Parameters<SshPtyDataCallback>[0]

const SSH_PTY_FRAME_REJECTION_LOG_KEY_LIMIT = 12

export type SshPtyFrameRejectionReason =
  | 'source-missing'
  | 'source-malformed'
  | 'client-generation-stale'
  | 'owner-generation-stale'
  | 'client-and-owner-generation-stale'
  | 'source-range-invalid'

export type SshPtyFrameRejection = Readonly<{
  reason: SshPtyFrameRejectionReason
  action: 'quarantine-legacy-frame' | 'retire-and-reattach-delivery'
}>

// Why a source-less frame is quarantined rather than reattached: it is the signature of legacy
// output already in flight when the flow-control grant landed, not of a broken delivery. The relay's
// own admission stops publishing those once the grant is live, and source recovery replays from
// sourceStartSu, so dropping them loses nothing. Reattaching instead would restart the PTY on every
// openClient handshake.
export function classifySshPtyFrameRejection(
  payload: SshPtyDataPayload,
  owner: SshPtyConsumerOwnerState | null
): SshPtyFrameRejection | null {
  if (payload.sourceMalformed) {
    return Object.freeze({
      reason: 'source-malformed',
      action: 'retire-and-reattach-delivery'
    })
  }
  const source = payload.source
  if (!source) {
    return owner?.outputFlowControl
      ? Object.freeze({
          reason: 'source-missing',
          action: 'quarantine-legacy-frame'
        })
      : null
  }
  if (!owner?.outputFlowControl) {
    return payload.sourceRejected
      ? Object.freeze({
          reason: 'source-range-invalid',
          action: 'retire-and-reattach-delivery'
        })
      : null
  }
  const staleClient = source.clientGeneration !== owner.clientGeneration
  const staleOwner = source.ownerGeneration !== owner.ownerGeneration
  if (staleClient || staleOwner) {
    return Object.freeze({
      reason:
        staleClient && staleOwner
          ? 'client-and-owner-generation-stale'
          : staleClient
            ? 'client-generation-stale'
            : 'owner-generation-stale',
      action: 'retire-and-reattach-delivery'
    })
  }
  if (payload.sourceRejected) {
    return Object.freeze({
      reason: 'source-range-invalid',
      action: 'retire-and-reattach-delivery'
    })
  }
  return null
}

/**
 * Why bounded: a quarantined frame carries no delivery token to retire, so nothing dedupes it — a
 * relay that keeps publishing legacy output to a flow-control owner would log once per frame and
 * bury every other diagnostic. One line per PTY and reason per generation names the fault; the
 * generation is itself the counter for how often it recurs.
 */
export class SshPtyFrameRejectionLog {
  private generation: number | null = null
  private readonly loggedKeys = new Set<string>()

  record(
    payload: SshPtyDataPayload,
    owner: SshPtyConsumerOwnerState | null,
    rejection: SshPtyFrameRejection
  ): void {
    if (this.generation !== payload.providerGeneration) {
      this.generation = payload.providerGeneration
      this.loggedKeys.clear()
    }
    const key = `${payload.id}\0${rejection.reason}`
    if (this.loggedKeys.has(key) || this.loggedKeys.size >= SSH_PTY_FRAME_REJECTION_LOG_KEY_LIMIT) {
      return
    }
    this.loggedKeys.add(key)
    console.warn('[ssh-relay-session] Rejected PTY delivery', {
      ptyId: payload.id,
      providerGeneration: payload.providerGeneration,
      expectedClientGeneration: owner?.clientGeneration ?? null,
      expectedOwnerGeneration: owner?.ownerGeneration ?? null,
      offeredClientGeneration: payload.source?.clientGeneration ?? null,
      offeredOwnerGeneration: payload.source?.ownerGeneration ?? null,
      sourceState: rejection.reason,
      recoveryAction: rejection.action
    })
  }

  clear(): void {
    this.generation = null
    this.loggedKeys.clear()
  }
}
