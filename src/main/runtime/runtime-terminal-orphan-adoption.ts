import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult
} from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { terminalOrphanExecutionOwnersEqual } from './terminal-orphan-owner'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'
import { buildRuntimeTerminalOrphanSession } from './runtime-terminal-orphan-session-adoption'
import { validateRuntimeTerminalOrphanTopology } from './runtime-terminal-orphan-topology-validation'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from './workspace-session-failed-write-rollback'

type RuntimeTerminalOrphanAdoptionPorts = {
  getPty: (handle: string) => RuntimePtyWorktreeRecord | null
  getLeaves: (ptyId: string) => readonly RuntimeLeafRecord[]
  getLeaf: (tabId: string, leafId: string) => RuntimeLeafRecord | undefined
  getMobileSnapshots: () => Iterable<RuntimeMobileSessionTabsSnapshot>
  getSession: (worktreeId: string) => WorkspaceSessionState | null
  setSession: (worktreeId: string, session: WorkspaceSessionState) => void
  flushSession: () => Promise<void>
  hydrateSession: (worktreeId: string) => void
  notifySessionChanged: (worktreeId: string) => void
  getSnapshot: (worktreeId: string) => RuntimeMobileSessionTabsResult
}

export async function adoptRuntimeTerminalOrphansFromInventory(args: {
  request: RuntimeTerminalOrphanAdoptionRequest
  workspace: TerminalWorkspaceLaunchScope
  inventory: PtyControllerInventory
  session: WorkspaceSessionState
  sessionWorktreeId: string
  repoId: string
  worktreeWslDistro: string | null
  currentRevision: number
  ports: RuntimeTerminalOrphanAdoptionPorts
}): Promise<RuntimeTerminalOrphanAdoptionResult> {
  const { request, workspace, inventory, session, sessionWorktreeId, currentRevision, ports } = args
  const seenPtyIds = new Set<string>()
  const seenPaneKeys = new Set<string>()
  const validated = request.claims.map((claim) => {
    const paneKey = makePaneKey(claim.tabId, claim.leafId)
    if (seenPtyIds.has(claim.ptyId) || seenPaneKeys.has(paneKey)) {
      throw new Error('terminal_orphan_claim_duplicate')
    }
    seenPtyIds.add(claim.ptyId)
    seenPaneKeys.add(paneKey)
    const pty = ports.getPty(claim.terminal)
    const controllerIdentity = inventory.terminalIdentityByPtyId.get(claim.ptyId)
    if (
      !pty ||
      pty.ptyId !== claim.ptyId ||
      controllerIdentity?.handle !== claim.terminal ||
      controllerIdentity?.incarnationId !== claim.incarnationId ||
      !inventory.livePtyIds.has(claim.ptyId) ||
      !pty.connected ||
      !pty.incarnationId ||
      pty.incarnationId !== claim.incarnationId
    ) {
      throw new Error('terminal_orphan_stale')
    }
    if (
      !runtimeWorktreeIdsEqual(pty.worktreeId, workspace.id) ||
      !terminalOrphanExecutionOwnersEqual(
        { connectionId: workspace.connectionId, wslDistro: args.worktreeWslDistro },
        {
          connectionId: pty.connectionId ?? null,
          ...(controllerIdentity?.wslDistro !== undefined
            ? { wslDistro: controllerIdentity.wslDistro }
            : process.platform === 'win32' && !workspace.connectionId
              ? {}
              : { wslDistro: null })
        }
      )
    ) {
      throw new Error('terminal_orphan_owner_mismatch')
    }
    if (
      ports
        .getLeaves(claim.ptyId)
        .some(
          (owner) =>
            !runtimeWorktreeIdsEqual(owner.worktreeId, workspace.id) ||
            owner.tabId !== claim.tabId ||
            owner.leafId !== claim.leafId
        )
    ) {
      throw new Error('terminal_orphan_already_visual')
    }
    if ((pty.tabId && pty.tabId !== claim.tabId) || (pty.paneKey && pty.paneKey !== paneKey)) {
      throw new Error('terminal_orphan_competing_owner')
    }
    return { claim, pty, paneKey }
  })

  const persistedBindings = new Map<string, { worktreeId: string; paneKey: string }[]>()
  const addBinding = (ptyId: string, worktreeId: string, paneKey: string): void => {
    const bindings = persistedBindings.get(ptyId) ?? []
    bindings.push({ worktreeId, paneKey })
    persistedBindings.set(ptyId, bindings)
  }
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree)) {
    for (const tab of tabs) {
      const layout = session.terminalLayoutsByTabId[tab.id]
      for (const [leafId, ptyId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
        if (ptyId) {
          addBinding(ptyId, worktreeId, makePaneKey(tab.id, leafId))
        }
      }
      if (tab.ptyId && !layout) {
        addBinding(tab.ptyId, worktreeId, tab.id)
      }
    }
  }
  const persistedBinding = (ptyId: string): { worktreeId: string; paneKey: string } | null => {
    const bindings = persistedBindings.get(ptyId) ?? []
    if (bindings.length > 1) {
      throw new Error('terminal_orphan_competing_owner')
    }
    return bindings[0] ?? null
  }
  const isExactPersisted = validated.every(({ claim, paneKey }) => {
    const binding = persistedBinding(claim.ptyId)
    return (
      binding !== null &&
      runtimeWorktreeIdsEqual(binding.worktreeId, workspace.id) &&
      binding.paneKey === paneKey &&
      session.terminalPtyIncarnationsByPaneKey?.[paneKey] === claim.incarnationId
    )
  })
  if (isExactPersisted && sessionWorktreeId === workspace.id) {
    for (const { claim, pty, paneKey } of validated) {
      pty.tabId = claim.tabId
      pty.paneKey = paneKey
    }
    return {
      adopted: false,
      topologyRevision: currentRevision,
      snapshot: ports.getSnapshot(workspace.id)
    }
  }
  if (currentRevision !== request.expectedTopologyRevision) {
    throw new Error('terminal_topology_conflict')
  }

  const { topologyTabsById, topologyGroups } = validateRuntimeTerminalOrphanTopology(
    request,
    validated
  )
  for (const { claim, paneKey } of validated) {
    const existingBinding = persistedBinding(claim.ptyId)
    if (
      existingBinding &&
      (!runtimeWorktreeIdsEqual(existingBinding.worktreeId, workspace.id) ||
        existingBinding.paneKey !== paneKey)
    ) {
      throw new Error('terminal_orphan_competing_owner')
    }
    const proposedPtyId =
      session.terminalLayoutsByTabId[claim.tabId]?.ptyIdsByLeafId?.[claim.leafId]
    if (proposedPtyId && proposedPtyId !== claim.ptyId) {
      throw new Error('terminal_orphan_surface_occupied')
    }
    const graphOwner = ports.getLeaf(claim.tabId, claim.leafId)
    if (
      graphOwner &&
      (graphOwner.ptyId !== claim.ptyId ||
        !runtimeWorktreeIdsEqual(graphOwner.worktreeId, workspace.id))
    ) {
      throw new Error('terminal_orphan_surface_occupied')
    }
    if (
      Object.entries(session.tabsByWorktree).some(
        ([ownerWorktreeId, tabs]) =>
          !runtimeWorktreeIdsEqual(ownerWorktreeId, workspace.id) &&
          tabs.some((tab) => tab.id === claim.tabId)
      )
    ) {
      throw new Error('terminal_orphan_surface_occupied')
    }
    if (session.terminalSurfaceTombstonesByPaneKey?.[paneKey]) {
      throw new Error('terminal_orphan_surface_retired')
    }
    for (const snapshot of ports.getMobileSnapshots()) {
      const surfaceOwner = snapshot.tabs.find(
        (tab) =>
          tab.type === 'terminal' && tab.parentTabId === claim.tabId && tab.leafId === claim.leafId
      )
      if (
        surfaceOwner?.type === 'terminal' &&
        (snapshot.worktree !== workspace.id || surfaceOwner.ptyId !== claim.ptyId)
      ) {
        throw new Error('terminal_orphan_surface_occupied')
      }
      const owner = snapshot.tabs.find(
        (tab) => tab.type === 'terminal' && tab.ptyId === claim.ptyId
      )
      if (
        owner?.type === 'terminal' &&
        (snapshot.worktree !== workspace.id ||
          owner.parentTabId !== claim.tabId ||
          owner.leafId !== claim.leafId)
      ) {
        throw new Error('terminal_orphan_competing_owner')
      }
    }
  }

  const persisted = buildRuntimeTerminalOrphanSession({
    session,
    sessionWorktreeId,
    worktreeId: workspace.id,
    request,
    validated,
    topologyTabsById,
    topologyGroups
  })
  let staged: WorkspaceSessionState | null = null
  try {
    ports.setSession(workspace.id, persisted)
    staged = ports.getSession(workspace.id)
    await ports.flushSession()
  } catch (error) {
    const current = ports.getSession(workspace.id)
    if (staged && current) {
      const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(session, staged, current)
      if (rolledBack !== current) {
        ports.setSession(workspace.id, rolledBack)
      }
    }
    throw error
  }
  for (const { claim, pty, paneKey } of validated) {
    pty.tabId = claim.tabId
    pty.paneKey = paneKey
  }
  ports.hydrateSession(workspace.id)
  ports.notifySessionChanged(workspace.id)
  return {
    adopted: true,
    topologyRevision:
      persisted.terminalTopologyRevisionByRepoId?.[args.repoId] ?? currentRevision + 1,
    snapshot: ports.getSnapshot(workspace.id)
  }
}
