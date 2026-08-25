import type { PersistedState } from '../../../shared/persisted-state-types'
import type { RemovedSshTargetTombstone, SshTarget } from '../../../shared/ssh-types'
import type { ProtectedSecretPersistence } from '../../protected-secret-persistence'
import { sshPtyOwnerLeaseSecretSlot } from '../../protected-secret-persistence'
import {
  MAX_CLAUDE_LIVE_PTY_SESSION_IDS,
  MAX_REMOVED_SSH_TARGET_TOMBSTONES
} from '../restoring-sessions/pane-alias-normalization'
import { normalizeSshTarget } from './ssh-normalization'
import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'
import {
  migrateRetirementNamespaceHostIdentity,
  sshHostIdentity
} from '../../worktree-retirement-namespace'

export type SshTargetStateOperations = {
  state: PersistedState
  protectedSecrets: Pick<ProtectedSecretPersistence, 'removeRetainedBlob'>
  scheduleSave: () => void
  flush: () => void
}

export function getSshTargets(state: PersistedState): SshTarget[] {
  return (state.sshTargets ?? []).map(normalizeSshTarget)
}

export function getSshTarget(state: PersistedState, id: string): SshTarget | undefined {
  const target = state.sshTargets?.find((entry) => entry.id === id)
  return target ? normalizeSshTarget(target) : undefined
}

export function addSshTarget(operations: SshTargetStateOperations, target: SshTarget): void {
  operations.state.sshTargets ??= []
  operations.state.sshTargets.push(normalizeSshTarget(target))
  operations.scheduleSave()
}

export function updateSshTarget(
  operations: SshTargetStateOperations,
  id: string,
  updates: Partial<Omit<SshTarget, 'id'>>
): SshTarget | null {
  const target = operations.state.sshTargets?.find((entry) => entry.id === id)
  if (!target) {
    return null
  }
  const normalized = normalizeSshTarget({ ...target, ...updates })
  const previousHostIdentity = sshHostIdentity(target)
  // Why: Object.assign only adds keys, so anything normalization stripped (retired sync fields, implicit defaults) must be deleted off the live target.
  const mutableTarget = target as Record<string, unknown>
  for (const key of Object.keys(mutableTarget)) {
    if (!Object.hasOwn(normalized, key)) {
      delete mutableTarget[key]
    }
  }
  Object.assign(target, normalized)
  // Why: an endpoint edit keeps the row id, so no re-adoption runs and nothing else would carry the
  // retirement mirror across — config sync rewrites host/port/username in place on every import.
  // Copied, not moved: another target may still sit on the old endpoint.
  //
  // Runtime-owned targets are excluded: an on-demand VM is discarded between provisions, so its
  // fresh address reaches an empty filesystem where a reissued name collides with nothing. Copying
  // there would spend names against history that no longer exists and, since each provision mints
  // another address, churn the namespace cap with a bucket per run — evicting the real tombstones
  // of local and ordinary SSH repos.
  if (!isRuntimeOwnedSshTargetId(id)) {
    migrateRetirementNamespaceHostIdentity(operations.state.retiredWorktreeNamesByNamespace, {
      copyFrom: [previousHostIdentity],
      to: sshHostIdentity(target)
    })
  }
  operations.scheduleSave()
  return { ...target }
}

export function removeSshTarget(operations: SshTargetStateOperations, id: string): void {
  const targets = operations.state.sshTargets ?? []
  const recoveries = operations.state.sshPtyConsumerRecoveries ?? []
  const nextTargets = targets.filter((target) => target.id !== id)
  const nextRecoveries = recoveries.filter((record) => record.targetId !== id)
  if (nextTargets.length === targets.length && nextRecoveries.length === recoveries.length) {
    return
  }
  operations.state.sshTargets = nextTargets
  operations.state.sshPtyConsumerRecoveries = nextRecoveries
  operations.protectedSecrets.removeRetainedBlob(sshPtyOwnerLeaseSecretSlot(id))
  operations.scheduleSave()
}

export function getClaudeLivePtySessionIds(state: PersistedState): string[] {
  return [...(state.claudeLivePtySessionIds ?? [])]
}

export function addClaudeLivePtySessionId(
  operations: SshTargetStateOperations,
  sessionId: string
): void {
  if (sessionId.length === 0 || sessionId.length > 512) {
    return
  }
  const ids = operations.state.claudeLivePtySessionIds ?? []
  if (ids.includes(sessionId)) {
    return
  }
  // Why: drop oldest at the cap — stale ids get pruned against the daemon at startup, so only recency matters.
  operations.state.claudeLivePtySessionIds = [...ids, sessionId].slice(
    -MAX_CLAUDE_LIVE_PTY_SESSION_IDS
  )
  // Why: flush sync so a force-quit right after a Claude spawn still seeds the live-PTY gate next launch.
  operations.flush()
}

export function removeClaudeLivePtySessionId(
  operations: SshTargetStateOperations,
  sessionId: string
): void {
  const ids = operations.state.claudeLivePtySessionIds ?? []
  if (!ids.includes(sessionId)) {
    return
  }
  operations.state.claudeLivePtySessionIds = ids.filter((id) => id !== sessionId)
  operations.scheduleSave()
}

export function getDeletedSshConfigAliases(state: PersistedState): string[] {
  return [...(state.deletedSshConfigAliases ?? [])]
}

export function addDeletedSshConfigAlias(
  operations: SshTargetStateOperations,
  alias: string
): void {
  operations.state.deletedSshConfigAliases ??= []
  if (!operations.state.deletedSshConfigAliases.includes(alias)) {
    operations.state.deletedSshConfigAliases.push(alias)
    operations.scheduleSave()
  }
}

export function removeDeletedSshConfigAlias(
  operations: SshTargetStateOperations,
  alias: string
): void {
  const current = operations.state.deletedSshConfigAliases
  if (!current || !current.includes(alias)) {
    return
  }
  operations.state.deletedSshConfigAliases = current.filter((entry) => entry !== alias)
  operations.scheduleSave()
}

export function clearDeletedSshConfigAliases(operations: SshTargetStateOperations): void {
  if (
    operations.state.deletedSshConfigAliases &&
    operations.state.deletedSshConfigAliases.length > 0
  ) {
    operations.state.deletedSshConfigAliases = []
    operations.scheduleSave()
  }
}

export function getRemovedSshTargetTombstones(state: PersistedState): RemovedSshTargetTombstone[] {
  return [...(state.removedSshTargetTombstones ?? [])]
}

export function addRemovedSshTargetTombstone(
  operations: SshTargetStateOperations,
  tombstone: RemovedSshTargetTombstone
): void {
  const existing = operations.state.removedSshTargetTombstones ?? []
  // Why: dedupe by oldTargetId so re-removing the same id can't stack duplicate tombstones; newest wins.
  const filtered = existing.filter((entry) => entry.oldTargetId !== tombstone.oldTargetId)
  // Cap the history so pathological churn can't grow the state file unbounded.
  operations.state.removedSshTargetTombstones = [...filtered, tombstone].slice(
    -MAX_REMOVED_SSH_TARGET_TOMBSTONES
  )
  operations.scheduleSave()
}

export function removeRemovedSshTargetTombstone(
  operations: SshTargetStateOperations,
  oldTargetId: string
): void {
  const existing = operations.state.removedSshTargetTombstones
  if (!existing?.some((entry) => entry.oldTargetId === oldTargetId)) {
    return
  }
  operations.state.removedSshTargetTombstones = existing.filter(
    (entry) => entry.oldTargetId !== oldTargetId
  )
  operations.scheduleSave()
}
