import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getPtyExecutionHost } from '../../../shared/terminal-execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { preserveMissingLeafRecordEntries } from '../restoring-sessions/terminal-layout-normalization'

import type { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'

type TerminalBindingRecovery = Pick<
  TerminalBindingRecoveryOperations,
  | 'getTerminalLayoutLeafIds'
  | 'getConnectionIdForWorktree'
  | 'isRestorablePtyBinding'
  | 'hasRestorableSshRemotePtyLease'
>

/** A bare tab id cannot select one binding when persisted rows disagree on its worktree. */
function collectAmbiguousTabIds(
  tabsByWorktree: WorkspaceSessionState['tabsByWorktree']
): ReadonlySet<string> {
  const ownerByTabId = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      if (ownerByTabId.has(tab.id)) {
        ambiguous.add(tab.id)
      } else {
        ownerByTabId.set(tab.id, worktreeId)
      }
    }
  }
  return ambiguous
}

export type WorkspaceSessionTerminalBindingReplayOptions = {
  /** Resolve the SSH target that owns bindings in a host partition. */
  targetIdForWorktree?: (worktreeId: string) => string | null
  /** Reject a binding that explicitly names another execution host. */
  executionHostId?: ExecutionHostId
}

function ptyBindingMatchesExecutionHost(
  ptyId: string,
  executionHostId: ExecutionHostId | undefined
): boolean {
  if (!executionHostId || executionHostId === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  const owner = getPtyExecutionHost(ptyId)
  // Legacy unscoped ids carry no host proof; lease/context checks below still
  // decide whether they are restorable. Known foreign ids must never cross a partition.
  return owner === null || owner === executionHostId
}

/**
 * Reapplies durable pane bindings omitted by an older or in-flight renderer snapshot.
 *
 * An empty binding map is ambiguous: it can be a pre-spawn snapshot, or an intentional close.
 * Lease/tombstone state is the authority that distinguishes those cases. A partial map is only
 * repaired when a live SSH lease proves the omitted sibling still belongs to this host.
 */
export function preserveMissingWorkspaceSessionTerminalBindings(
  session: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined,
  bindingRecovery: TerminalBindingRecovery,
  options: WorkspaceSessionTerminalBindingReplayOptions = {}
): WorkspaceSessionState {
  if (!prior) {
    return session
  }

  const priorTabs = prior.tabsByWorktree ?? {}
  const nextTabs = session.tabsByWorktree ?? {}
  const priorLayouts = prior.terminalLayoutsByTabId ?? {}
  const nextLayouts = session.terminalLayoutsByTabId ?? {}
  // Both snapshots are independently allowed to contain the same id during a
  // normal worktree move. Only ids duplicated within one snapshot are unsafe;
  // skip their replay rather than assigning a global layout to an arbitrary row.
  const ambiguousTabIds = new Set<string>([
    ...collectAmbiguousTabIds(priorTabs),
    ...collectAmbiguousTabIds(nextTabs)
  ])
  const targetIdForWorktree =
    options.targetIdForWorktree ??
    ((worktreeId: string) => bindingRecovery.getConnectionIdForWorktree(worktreeId))

  // Keep a tab-level binding when the renderer has not observed the host's spawn yet.
  for (const [worktreeId, tabs] of Object.entries(nextTabs)) {
    const priorList = priorTabs[worktreeId]
    if (!priorList) {
      continue
    }
    for (const tab of tabs) {
      if (ambiguousTabIds.has(tab.id)) {
        continue
      }
      if (tab.ptyId) {
        continue
      }
      const priorTab = priorList.find((candidate) => candidate.id === tab.id)
      const incomingLayout = nextLayouts[tab.id]
      const priorLayout = priorLayouts[tab.id]
      const priorPtyLeafId = priorLayout
        ? Object.entries(priorLayout.ptyIdsByLeafId ?? {}).find(
            ([, ptyId]) => ptyId === priorTab?.ptyId
          )?.[0]
        : undefined
      const bindingLeafWasRemoved =
        incomingLayout !== undefined &&
        priorPtyLeafId !== undefined &&
        !bindingRecovery.getTerminalLayoutLeafIds(incomingLayout.root).has(priorPtyLeafId)
      if (
        priorTab?.ptyId &&
        !bindingLeafWasRemoved &&
        ptyBindingMatchesExecutionHost(priorTab.ptyId, options.executionHostId) &&
        bindingRecovery.isRestorablePtyBinding({
          ptyId: priorTab.ptyId,
          worktreeId,
          targetId: targetIdForWorktree(worktreeId),
          tabId: tab.id
        })
      ) {
        tab.ptyId = priorTab.ptyId
      }
    }
  }

  const worktreeIdByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries({ ...priorTabs, ...nextTabs })) {
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
    }
  }

  for (const [tabId, layout] of Object.entries(nextLayouts)) {
    if (ambiguousTabIds.has(tabId)) {
      continue
    }
    const priorLayout = priorLayouts[tabId]
    if (!priorLayout?.ptyIdsByLeafId) {
      continue
    }
    const incoming = layout.ptyIdsByLeafId ?? {}
    const incomingHasAnyBinding = Object.keys(incoming).length > 0
    const liveLeafIds = bindingRecovery.getTerminalLayoutLeafIds(layout.root)
    const worktreeId = worktreeIdByTabId.get(tabId)
    const targetId = worktreeId ? targetIdForWorktree(worktreeId) : null
    const restorableBindings = Object.fromEntries(
      Object.entries(priorLayout.ptyIdsByLeafId).filter(
        ([leafId, ptyId]) =>
          liveLeafIds.has(leafId) &&
          incoming[leafId] === undefined &&
          ptyBindingMatchesExecutionHost(ptyId, options.executionHostId) &&
          // An empty map may be a stale pre-spawn snapshot; a partial map is intentional unless
          // a durable SSH lease proves the omitted sibling is still live on this host.
          (incomingHasAnyBinding
            ? bindingRecovery.hasRestorableSshRemotePtyLease({
                ptyId,
                targetId,
                worktreeId,
                tabId,
                leafId
              })
            : bindingRecovery.isRestorablePtyBinding({
                ptyId,
                targetId,
                worktreeId,
                tabId,
                leafId
              }))
      )
    )
    if (Object.keys(restorableBindings).length === 0) {
      continue
    }

    layout.ptyIdsByLeafId = { ...restorableBindings, ...incoming }
    // Keep pane metadata alongside a binding rescued from a stale renderer write.
    const buffersByLeafId = preserveMissingLeafRecordEntries(
      priorLayout.buffersByLeafId,
      layout.buffersByLeafId,
      liveLeafIds
    )
    const scrollbackRefsByLeafId = preserveMissingLeafRecordEntries(
      priorLayout.scrollbackRefsByLeafId,
      layout.scrollbackRefsByLeafId,
      liveLeafIds
    )
    const titlesByLeafId = preserveMissingLeafRecordEntries(
      priorLayout.titlesByLeafId,
      layout.titlesByLeafId,
      liveLeafIds
    )
    if (buffersByLeafId) {
      layout.buffersByLeafId = buffersByLeafId
    }
    if (scrollbackRefsByLeafId) {
      layout.scrollbackRefsByLeafId = scrollbackRefsByLeafId
    }
    if (titlesByLeafId) {
      layout.titlesByLeafId = titlesByLeafId
    }
  }

  return session
}

/** Target resolver for a persisted execution-host partition. */
export function sshTargetIdForWorkspaceSessionHost(
  hostId: ExecutionHostId
): ((worktreeId: string) => string | null) | undefined {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return undefined
  }
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'ssh' ? () => parsed.targetId : () => null
}
