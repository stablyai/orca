import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  inspectReservedPtyOwnershipTransferLayoutAdmission,
  type ReservedPtyOwnershipTransferLayout
} from '../loading-store/pty-ownership-transfer-reserved-layout-admission'

const same = (left: unknown, right: unknown) =>
  serializeOrcadMigrationValue(left) === serializeOrcadMigrationValue(right)

/** Caller must first verify each live overlay's journal, catalog authority and artifact. */
export function projectOrcadLiveSessionForCatalog(
  current: WorkspaceSessionState,
  incoming: WorkspaceSessionState,
  reservations: readonly ReservedPtyOwnershipTransferLayout[],
  options: { allowPartialOwner?: boolean } = {}
) {
  current = structuredClone(current)
  reservations = structuredClone(reservations)
  const comparison = structuredClone(current)
  const tabs = new Set<string>()
  const owners = new Set<string>()
  for (const reservation of reservations) {
    const { tab, layout, worktreeId, bindings } = reservation
    if (
      tabs.has(tab.id) ||
      !same(
        incoming.tabsByWorktree[worktreeId]?.find((entry) => entry.id === tab.id),
        tab
      ) ||
      !same(incoming.terminalLayoutsByTabId[tab.id], layout) ||
      bindings.some(
        (binding) =>
          inspectReservedPtyOwnershipTransferLayoutAdmission(current, binding, reservation) ===
          'conflict'
      )
    ) {
      throw new Error('orcad_migration_live_session_projection_conflict')
    }
    tabs.add(tab.id)
    if (!current.terminalLayoutsByTabId[tab.id]) {
      continue
    }
    owners.add(worktreeId)
    comparison.tabsByWorktree[worktreeId] = comparison.tabsByWorktree[worktreeId].map((entry) =>
      entry.id === tab.id ? structuredClone(tab) : entry
    )
    comparison.terminalLayoutsByTabId[tab.id] = structuredClone(layout)
    for (const binding of bindings) {
      delete comparison.terminalPtyIncarnationsByPaneKey?.[`${tab.id}:${binding.leafId}`]
    }
  }
  for (const owner of owners) {
    const existing = comparison.tabsByWorktree[owner]
    const expected = incoming.tabsByWorktree[owner]
    // Only an exact ordered subset of the incoming owner may be materialized before commit.
    if (
      (!options.allowPartialOwner && !same(existing, expected)) ||
      !same(
        existing,
        expected.filter((tab) => existing.some((entry) => entry.id === tab.id))
      )
    ) {
      throw new Error('orcad_migration_live_session_owner_conflict')
    }
    comparison.tabsByWorktree[owner] = structuredClone(expected)
  }
  return {
    comparison,
    restoreLiveOverlays(merged: WorkspaceSessionState): WorkspaceSessionState {
      const result = structuredClone(merged)
      for (const reservation of reservations) {
        const { tab, worktreeId, bindings } = reservation
        const layout = current.terminalLayoutsByTabId[tab.id]
        if (!layout) {
          continue
        }
        const liveTab = current.tabsByWorktree[worktreeId].find((entry) => entry.id === tab.id)!
        result.tabsByWorktree[worktreeId] = result.tabsByWorktree[worktreeId].map((entry) =>
          entry.id === tab.id ? structuredClone(liveTab) : entry
        )
        result.terminalLayoutsByTabId[tab.id] = structuredClone(layout)
        for (const binding of bindings) {
          const key = `${tab.id}:${binding.leafId}`
          const incarnation = current.terminalPtyIncarnationsByPaneKey?.[key]
          if (incarnation !== undefined) {
            result.terminalPtyIncarnationsByPaneKey = {
              ...result.terminalPtyIncarnationsByPaneKey,
              [key]: incarnation
            }
          }
        }
      }
      for (const [repoId, revision] of Object.entries(
        current.terminalTopologyRevisionByRepoId ?? {}
      )) {
        result.terminalTopologyRevisionByRepoId = {
          ...result.terminalTopologyRevisionByRepoId,
          [repoId]: Math.max(revision, result.terminalTopologyRevisionByRepoId?.[repoId] ?? 0)
        }
      }
      return result
    }
  }
}
