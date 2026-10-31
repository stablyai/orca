import type { RemovedSshTargetTombstone } from '../../../shared/ssh-types'
import type { PersistedAutomationHostFilter } from '../../../shared/automation-host-filter'
import { parseHostStableKey } from '../../../shared/automation-owner-key'
import { resolveAutomationWorkspaceSshTargetId } from '../../../shared/automation-workspace-pin'
import type { FolderWorkspaceHostState } from '../../../shared/folder-workspace-execution-host'

export const MAX_REMOVED_SSH_TARGET_TOMBSTONES = 50

/** Retain referenced removal evidence beyond the cap or orphaned automations lose their host history; evict unreferenced entries oldest-first. */
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

function persistedAutomationHostFilterSshTargetId(
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

type SshTargetRemovalEvidenceDependents = {
  automations: readonly {
    executionTargetType: string
    executionTargetId: string
    workspaceId?: string | null
  }[]
  automationHostFilter?: PersistedAutomationHostFilter
  /** Folder-workspace pins are indirect automation host references. */
  workspaceState?: FolderWorkspaceHostState
}

/** Dependencies pin removal evidence beyond the tombstone cap. */
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
