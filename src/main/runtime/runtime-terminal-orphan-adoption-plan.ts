import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeTerminalOrphanAdoptionRequest
} from '../../shared/runtime-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { makePaneKey } from '../../shared/stable-pane-id'
import { hasClosedTerminalTabRecord } from '../../shared/closed-terminal-tab-tombstones'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { terminalOrphanExecutionOwnersEqual } from './terminal-orphan-owner'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'
import { buildRuntimeTerminalOrphanSession } from './runtime-terminal-orphan-session-adoption'
import { validateRuntimeTerminalOrphanTopology } from './runtime-terminal-orphan-topology-validation'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { worktreeIdsEqual } from '../../shared/worktree/id'

/** The host session an adoption is checked against, read where the adoption is written. */
export type RuntimeTerminalOrphanAdoptionSession = {
  session: WorkspaceSessionState
  sessionWorktreeId: string
  currentRevision: number
}

export type RuntimeTerminalOrphanAdoptionPlanPorts = {
  getPty: (handle: string) => RuntimePtyWorktreeRecord | null
  getLeaves: (ptyId: string) => readonly RuntimeLeafRecord[]
  getLeaf: (tabId: string, leafId: string) => RuntimeLeafRecord | undefined
  /** The title display surfaces show for the PTY, which an adopted tab persists. */
  getDisplayTitle: (pty: RuntimePtyWorktreeRecord) => string | null
  getMobileSnapshots: () => Iterable<RuntimeMobileSessionTabsSnapshot>
}

export type RuntimeTerminalOrphanAdoptionPlanArgs = {
  /** The partition the session is read from and written to. */
  hostId: ExecutionHostId
  request: RuntimeTerminalOrphanAdoptionRequest
  workspace: TerminalWorkspaceLaunchScope
  inventory: PtyControllerInventory
  worktreeWslDistro: string | null
  ports: RuntimeTerminalOrphanAdoptionPlanPorts
}

type ValidatedClaim = {
  claim: RuntimeTerminalOrphanAdoptionRequest['claims'][number]
  pty: RuntimePtyWorktreeRecord
  paneKey: string
}

export type RuntimeTerminalOrphanAdoptionPlan =
  | { kind: 'replay'; validated: ValidatedClaim[]; currentRevision: number }
  | {
      kind: 'adopt'
      validated: ValidatedClaim[]
      currentRevision: number
      session: WorkspaceSessionState
      persisted: WorkspaceSessionState
    }

/** Checks every claim against `read` and builds the session to write; throws the refusal code. */
export function planRuntimeTerminalOrphanAdoption(
  args: RuntimeTerminalOrphanAdoptionPlanArgs,
  read: RuntimeTerminalOrphanAdoptionSession
): RuntimeTerminalOrphanAdoptionPlan {
  const { request, workspace, inventory, ports } = args
  const { session, sessionWorktreeId, currentRevision } = read
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
      !worktreeIdsEqual(pty.worktreeId, workspace.id) ||
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
            !worktreeIdsEqual(owner.worktreeId, workspace.id) ||
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
      worktreeIdsEqual(binding.worktreeId, workspace.id) &&
      binding.paneKey === paneKey &&
      session.terminalPtyIncarnationsByPaneKey?.[paneKey] === claim.incarnationId
    )
  })
  if (isExactPersisted && sessionWorktreeId === workspace.id) {
    return { kind: 'replay', validated, currentRevision }
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
      (!worktreeIdsEqual(existingBinding.worktreeId, workspace.id) ||
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
      (graphOwner.ptyId !== claim.ptyId || !worktreeIdsEqual(graphOwner.worktreeId, workspace.id))
    ) {
      throw new Error('terminal_orphan_surface_occupied')
    }
    if (
      Object.entries(session.tabsByWorktree).some(
        ([ownerWorktreeId, tabs]) =>
          !worktreeIdsEqual(ownerWorktreeId, workspace.id) &&
          tabs.some((tab) => tab.id === claim.tabId)
      )
    ) {
      throw new Error('terminal_orphan_surface_occupied')
    }
    // Why the close record too: it outlives a host restart, which the client's retirement proofs do not.
    if (
      session.terminalSurfaceTombstonesByPaneKey?.[paneKey] ||
      hasClosedTerminalTabRecord(session.closedTerminalTabTombstonesByTabId, claim.tabId)
    ) {
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
    hostId: args.hostId,
    session,
    sessionWorktreeId,
    worktreeId: workspace.id,
    request,
    validated,
    topologyTabsById,
    topologyGroups,
    getDisplayTitle: ports.getDisplayTitle
  })
  return { kind: 'adopt', validated, currentRevision, session, persisted }
}
