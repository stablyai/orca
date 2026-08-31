import type { RemovedSshTargetTombstone } from '../../shared/ssh-types'
import type { PersistedAutomationHostFilter } from '../../shared/automation-host-filter'
import { parseHostStableKey } from '../../shared/automation-owner-key'
import { resolveAutomationWorkspaceSshTargetId } from '../../shared/automation-workspace-pin'
import type { FolderWorkspaceHostState } from '../../shared/folder-workspace-execution-host'

// Why: bound removed-SSH-target history so remove/re-add churn can't grow the file unbounded.
export const MAX_REMOVED_SSH_TARGET_TOMBSTONES = 50

/**
 * Apply the tombstone cap while retaining positive removal evidence something
 * still depends on. A tombstone referenced by a stored automation is the only
 * proof that its ghost host ever existed, so evicting it would silently turn an
 * orphaned automation into an unexplained record. Referenced tombstones are kept
 * past the cap; unreferenced ones are dropped oldest-first.
 */
export function capRemovedSshTargetTombstones(
  tombstones: readonly RemovedSshTargetTombstone[],
  referencedTargetIds: ReadonlySet<string>,
  cap = MAX_REMOVED_SSH_TARGET_TOMBSTONES
): RemovedSshTargetTombstone[] {
  if (tombstones.length <= cap) {
    return [...tombstones]
  }
  const unreferencedToDrop = new Set<number>()
  let dropCount = tombstones.length - cap
  for (let index = 0; index < tombstones.length && dropCount > 0; index += 1) {
    if (!referencedTargetIds.has(tombstones[index].oldTargetId)) {
      unreferencedToDrop.add(index)
      dropCount -= 1
    }
  }
  return tombstones.filter((_, index) => !unreferencedToDrop.has(index))
}

/** SSH target ids stored automations still point at — the tombstones that must survive the cap. */
export function collectAutomationReferencedSshTargetIds(
  automations: readonly { executionTargetType: string; executionTargetId: string }[]
): Set<string> {
  const ids = new Set<string>()
  for (const automation of automations) {
    if (automation.executionTargetType === 'ssh' && automation.executionTargetId) {
      ids.add(automation.executionTargetId)
    }
  }
  return ids
}

/** Desktop SSH target id the persisted Automations host filter still names, if any. */
export function persistedAutomationHostFilterSshTargetId(
  filter: PersistedAutomationHostFilter | undefined
): string | null {
  if (filter?.kind !== 'host') {
    return null
  }
  const host = parseHostStableKey(filter.hostKey)
  return host?.authority.kind === 'desktop' && host.selector.kind === 'ssh'
    ? host.selector.targetId
    : null
}

export type SshTargetRemovalEvidenceDependents = {
  automations: readonly {
    executionTargetType: string
    executionTargetId: string
    workspaceId?: string | null
  }[]
  automationHostFilter?: PersistedAutomationHostFilter
  /** Folder-workspace pins are indirect automation host references. */
  workspaceState?: FolderWorkspaceHostState
}

/** Everything that still depends on removal evidence: a tombstone for one of these is never discarded. */
export function collectSshTargetRemovalEvidenceDependencies(
  input: SshTargetRemovalEvidenceDependents
): Set<string> {
  const ids = collectAutomationReferencedSshTargetIds(input.automations)
  if (input.workspaceState) {
    for (const automation of input.automations) {
      const targetId = resolveAutomationWorkspaceSshTargetId(
        input.workspaceState,
        automation.workspaceId ?? null
      )
      if (targetId) {
        ids.add(targetId)
      }
    }
  }
  const filterTargetId = persistedAutomationHostFilterSshTargetId(input.automationHostFilter)
  if (filterTargetId) {
    ids.add(filterTargetId)
  }
  return ids
}
