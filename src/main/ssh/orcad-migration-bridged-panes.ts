import type { OrcadMigrationCatalogPayload } from '../../shared/orcad-migration/orcad-migration-manifest'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import { collectLeafIds } from '../../shared/terminal-pane-layout-tree'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../shared/workspace-scope'

export type OrcadMigrationPaneLeasePredicate = (lease: SshRemotePtyLease) => boolean

/** Skipping saved state is safe only if every bridged terminal keeps its tab and stable leaf. */
export function preservesOrcadMigrationBridgedPanes(
  payload: OrcadMigrationCatalogPayload,
  leases: readonly SshRemotePtyLease[],
  bridgedPtyIds: readonly string[],
  isBridgedPaneLease?: OrcadMigrationPaneLeasePredicate
): boolean {
  if (bridgedPtyIds.length === 0) {
    return true
  }
  const session = payload.dormantState?.workspaceSession
  if (!session) {
    return false
  }
  const ownersByTabId = new Map<string, Set<string>>()
  const addOwner = (tabId: string, owner: string): void => {
    const owners = ownersByTabId.get(tabId) ?? new Set<string>()
    owners.add(normalizeWorkspaceSessionKeyToWorkspaceId(owner))
    ownersByTabId.set(tabId, owners)
  }
  for (const [owner, tabs] of Object.entries(session.tabsByWorktree)) {
    for (const tab of tabs) {
      addOwner(tab.id, owner)
    }
  }
  for (const [owner, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    for (const tab of tabs) {
      if (tab.contentType === 'terminal') {
        addOwner(tab.id, owner)
        addOwner(tab.entityId, owner)
      }
    }
  }
  const leasesById = new Map(leases.map((lease) => [lease.ptyId, lease]))
  return bridgedPtyIds.every((ptyId) => {
    const lease = leasesById.get(ptyId)
    if (lease && isBridgedPaneLease && !isBridgedPaneLease(lease)) {
      return true
    }
    if (!lease?.tabId || !lease.leafId) {
      return false
    }
    const owners = ownersByTabId.get(lease.tabId)
    return (
      owners?.size === 1 &&
      (!lease.worktreeId ||
        owners.has(normalizeWorkspaceSessionKeyToWorkspaceId(lease.worktreeId))) &&
      collectLeafIds(session.terminalLayoutsByTabId[lease.tabId]?.root).includes(lease.leafId)
    )
  })
}
