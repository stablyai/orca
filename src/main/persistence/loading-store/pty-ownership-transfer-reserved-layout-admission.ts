import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'
import {
  inspectPtyOwnershipTransferBindingAdmission,
  type PtyOwnershipTransferBindingAdmission,
  type PtyOwnershipTransferBindingAdmissionState
} from './pty-ownership-transfer-binding-admission'

export type ReservedPtyOwnershipTransferLayout = {
  worktreeId: string
  tab: TerminalTab
  layout: TerminalLayoutSnapshot
  bindings: readonly PtyOwnershipTransferBindingAdmission[]
}

const same = (left: unknown, right: unknown): boolean =>
  serializeOrcadMigrationValue(left) === serializeOrcadMigrationValue(right)

/** Reservation authenticity and snapshot bytes remain the destination authority's responsibility. */
export function inspectReservedPtyOwnershipTransferLayoutAdmission(
  session: WorkspaceSessionState,
  requested: PtyOwnershipTransferBindingAdmission,
  reservation: ReservedPtyOwnershipTransferLayout
): PtyOwnershipTransferBindingAdmissionState {
  const { tab, layout, bindings, worktreeId } = reservation
  const leaves = collectLayoutLeafIdsInOrder(layout.root)
  if (
    !worktreeId ||
    tab.worktreeId !== worktreeId ||
    tab.ptyId !== null ||
    leaves.length === 0 ||
    leaves.some((leaf) => !isTerminalLeafId(leaf)) ||
    new Set(leaves).size !== leaves.length ||
    bindings.length === 0 ||
    new Set(bindings.map((binding) => binding.leafId)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.ptyId)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.incarnationId)).size !== bindings.length ||
    Object.keys(layout.ptyIdsByLeafId ?? {}).length > 0 ||
    Object.keys(layout.buffersByLeafId ?? {}).length > 0 ||
    Object.keys(layout.scrollbackRefsByLeafId ?? {}).some((leaf) => !leaves.includes(leaf)) ||
    Object.keys(layout.titlesByLeafId ?? {}).some((leaf) => !leaves.includes(leaf)) ||
    bindings.some(
      (binding) =>
        binding.worktreeId !== worktreeId ||
        binding.tabId !== tab.id ||
        !leaves.includes(binding.leafId) ||
        !binding.ptyId ||
        !binding.incarnationId
    ) ||
    !bindings.some((binding) => same(binding, requested)) ||
    session.closedTerminalTabTombstonesByTabId?.[tab.id]
  ) {
    return 'conflict'
  }

  const claims = Object.entries(session.tabsByWorktree).flatMap(([owner, tabs]) =>
    tabs
      .filter((candidate) => candidate.id === tab.id)
      .map((candidate) => ({ owner, tab: candidate }))
  )
  const current = session.terminalLayoutsByTabId[tab.id]
  if (claims.length > 1 || (claims.length === 0) !== (current === undefined)) {
    return 'conflict'
  }
  if (
    Object.keys(session.terminalPtyIncarnationsByPaneKey ?? {}).some(
      (key) =>
        key.startsWith(`${tab.id}:`) &&
        !bindings.some((binding) => key === `${tab.id}:${binding.leafId}`)
    )
  ) {
    return 'conflict'
  }
  const published = new Set<string>()
  if (current) {
    for (const binding of bindings) {
      const pty = current.ptyIdsByLeafId?.[binding.leafId]
      const incarnation = session.terminalPtyIncarnationsByPaneKey?.[`${tab.id}:${binding.leafId}`]
      if (pty === undefined && incarnation === undefined) {
        continue
      }
      if (pty !== binding.ptyId || incarnation !== binding.incarnationId) {
        return 'conflict'
      }
      published.add(binding.leafId)
    }
    const primary = bindings.find((binding) => binding.leafId === leaves[0])
    if (
      claims[0]?.owner !== worktreeId ||
      !same(claims[0]?.tab, {
        ...tab,
        ptyId: primary && published.has(primary.leafId) ? primary.ptyId : null
      })
    ) {
      return 'conflict'
    }
    const expectedRefs = { ...layout.scrollbackRefsByLeafId }
    for (const [leaf, ref] of Object.entries(current.scrollbackRefsByLeafId ?? {})) {
      if (published.has(leaf)) {
        if (!/^v1-[0-9a-f]{32}$/.test(ref)) {
          return 'conflict'
        }
        expectedRefs[leaf] = ref
      }
    }
    if (
      !same(
        { ...current, ptyIdsByLeafId: {}, scrollbackRefsByLeafId: expectedRefs },
        {
          ...layout,
          ptyIdsByLeafId: {},
          scrollbackRefsByLeafId: expectedRefs
        }
      ) ||
      !same(current.scrollbackRefsByLeafId ?? {}, expectedRefs) ||
      Object.keys(current.ptyIdsByLeafId ?? {}).some((leaf) => !published.has(leaf))
    ) {
      return 'conflict'
    }
  }

  // Remove only proven reservation-owned overlays before reusing global collision checks.
  const outside = structuredClone(session)
  outside.tabsByWorktree[worktreeId] = (outside.tabsByWorktree[worktreeId] ?? []).filter(
    (candidate) => candidate.id !== tab.id
  )
  delete outside.terminalLayoutsByTabId[tab.id]
  const reservedLeaves = new Set(leaves)
  if (
    Object.values(outside.terminalLayoutsByTabId).some((candidate) =>
      [
        ...collectLayoutLeafIdsInOrder(candidate.root),
        ...Object.keys(candidate.ptyIdsByLeafId ?? {}),
        ...Object.keys(candidate.scrollbackRefsByLeafId ?? {}),
        ...Object.keys(candidate.buffersByLeafId ?? {}),
        ...Object.keys(candidate.titlesByLeafId ?? {})
      ].some((leaf) => reservedLeaves.has(leaf))
    ) ||
    Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {}).some((tombstone) =>
      reservedLeaves.has(tombstone.leafId)
    ) ||
    Object.keys(outside.terminalPtyIncarnationsByPaneKey ?? {}).some(
      (key) =>
        !key.startsWith(`${tab.id}:`) && reservedLeaves.has(key.slice(key.lastIndexOf(':') + 1))
    )
  ) {
    return 'conflict'
  }
  for (const binding of bindings) {
    if (published.has(binding.leafId)) {
      delete outside.terminalPtyIncarnationsByPaneKey?.[`${tab.id}:${binding.leafId}`]
    }
  }
  for (const [owner, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    if (
      tabs.some(
        (candidate) =>
          (candidate.id === tab.id || candidate.entityId === tab.id) &&
          (owner !== worktreeId ||
            candidate.worktreeId !== worktreeId ||
            candidate.contentType !== 'terminal')
      )
    ) {
      return 'conflict'
    }
  }
  if (
    bindings.some(
      (binding) => inspectPtyOwnershipTransferBindingAdmission(outside, binding) !== 'absent'
    )
  ) {
    return 'conflict'
  }
  return published.has(requested.leafId) ? 'published' : 'absent'
}
