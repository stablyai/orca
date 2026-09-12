import { join } from 'node:path'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { SshRelayResetIntentStore } from '../ssh/ssh-relay-reset-intent-store'
import { SshResetOperationAuthorities } from './ssh-reset-operation-authority'
import { activeSessions } from './ssh-active-relay-sessions'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import { sshRelayResetRecordDigest } from '../ssh/ssh-relay-reset-retirement-record'

export const sshResetOperationAuthorities = new SshResetOperationAuthorities(activeSessions)
const captures = new Map<string, object>()

export function getRetainedSshResetTargetIds(): string[] {
  return [...new Set([...captures.keys(), ...sshResetOperationAuthorities.getTargetIds()])]
}

export function getSshResetIntentStore(): SshRelayResetIntentStore {
  return new SshRelayResetIntentStore(join(getCanonicalUserDataPath(), 'ssh-relay-resets'))
}

export function assertSshResetAdmissionAllowed(targetId: string): void {
  // A retired disk marker does not release an operation's unfinished in-memory cleanup.
  if (
    captures.has(targetId) ||
    sshResetOperationAuthorities.get(targetId) ||
    getSshResetIntentStore().read(targetId)
  ) {
    throw new Error('ssh_reset_operation_reconciliation_required')
  }
}

export function reserveSshResetCapture(targetId: string) {
  assertSshResetAdmissionAllowed(targetId)
  return reserveSshResetSlot(targetId)
}

function reserveSshResetSlot(targetId: string) {
  const token = Object.freeze({})
  captures.set(targetId, token)
  const assertCurrent = () => {
    if (captures.get(targetId) !== token) {
      throw new Error('ssh_reset_capture_reservation_changed')
    }
  }
  return {
    assertCurrent,
    release: () => {
      assertCurrent()
      if (sshResetOperationAuthorities.get(targetId)) {
        throw new Error('ssh_reset_capture_authority_still_retained')
      }
      captures.delete(targetId)
    }
  }
}

/** Process-local admission only; caller must separately prove prior resource retirement. */
export function reserveSshResetRecovery(value: SshRelayResetIntent) {
  const intent = parseSshRelayResetIntent(value)
  const targetId = intent.targetId
  const profile = getCanonicalUserDataPath()
  if (
    captures.has(targetId) ||
    sshResetOperationAuthorities.get(targetId) ||
    activeSessions.has(targetId)
  ) {
    throw new Error('ssh_reset_recovery_operation_still_live')
  }
  const records = getSshResetIntentStore()
  const intentDigest = sshRelayResetRecordDigest(intent)
  if (sshRelayResetRecordDigest(records.read(targetId)) !== intentDigest) {
    throw new Error('ssh_reset_recovery_intent_changed')
  }
  const selection = records.readSelection(intent)
  if (!selection) {
    throw new Error('ssh_reset_recovery_selection_missing')
  }
  const selectionDigest = sshRelayResetRecordDigest(selection)
  const slot = reserveSshResetSlot(targetId)
  const assertCurrent = () => {
    slot.assertCurrent()
    if (getCanonicalUserDataPath() !== profile) {
      throw new Error('ssh_reset_recovery_profile_changed')
    }
    if (sshResetOperationAuthorities.get(targetId) || activeSessions.has(targetId)) {
      throw new Error('ssh_reset_recovery_operation_still_live')
    }
    const active = records.read(targetId)
    const retired = active === null ? records.readRetiredArchive(intent) : null
    if (
      (active ? sshRelayResetRecordDigest(active) !== intentDigest : !retired) ||
      sshRelayResetRecordDigest(records.readSelection(intent)) !== selectionDigest
    ) {
      throw new Error('ssh_reset_recovery_records_changed')
    }
  }
  return {
    intent,
    selection,
    assertCurrent,
    release: () => {
      assertCurrent()
      if (!records.readRetiredArchive(intent)) {
        throw new Error('ssh_reset_recovery_retirement_required')
      }
      slot.release()
    }
  }
}

/** Background callbacks must also stay fenced when durable evidence is unreadable. */
export function isSshResetAdmissionBlocked(targetId: string): boolean {
  try {
    assertSshResetAdmissionAllowed(targetId)
    return false
  } catch {
    return true
  }
}
