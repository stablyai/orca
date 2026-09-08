import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  cloneLayoutNode,
  layoutContainsLeafId
} from '../restoring-sessions/terminal-layout-normalization'
import {
  cloneWorkspaceSessionState,
  createMinimalPersistedTerminalTab
} from '../restoring-sessions/session-owner-fields'

import type { PtyBindingSourceExpectation } from './store'

import type { StoreRuntimeState } from './store-runtime-state'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import { resolveHostId } from './session-host-partitions'
import { evaluatePtyBindingFastLane } from './pty-binding-fast-lane'
import { ptyBindingIsRefused } from './pty-binding-refusals'
import { startPtyBindingSpan, type PtyBindingOrigin } from './pty-binding-span'

type PtyBindingPersistenceOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'flushOrThrow'
  | 'lastDurableWriteGeneration'
  | 'pendingWrite'
  | 'quitFlushStarted'
  | 'state'
  | 'writeGeneration'
  | 'writeTimer'
>

type PersistPtyBindingArgs = {
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
  startupCwd?: string
  expectedBinding?: { ptyId: string; incarnationId?: string }
  expectedSourceBinding?: PtyBindingSourceExpectation
  /** Set by host-initiated creates, which have no renderer session writer behind them. */
  hostAdmittedMembership?: boolean
  /**
   * Defaults true, which is what `pty:spawn` needs — it can beat the debounced layout writer
   * and must be able to mint the surface it is binding. A reattach is the opposite: the pane
   * either still exists or the user closed it, so creating one grafts back a tab they closed.
   * Callers pass false only once absence is meaningful; see the relay's reattach bind.
   */
  mayCreate?: boolean
  /** Reattach must not revive a surface a prior build durably recorded as retired. */
  mayReviveRetiredSurface?: boolean
  /** Span metadata only; see `PtyBindingOrigin`. The write path never reads it. */
  origin?: PtyBindingOrigin
}

const ptyBindingPersistenceOperationsContext = Symbol('PtyBindingPersistenceOperations')
type PtyBindingPersistenceOperationsContext = {
  runtime: PtyBindingPersistenceOperationsRuntime
  sessions: SessionHostPartitionOperations
}

export class PtyBindingPersistenceOperations {
  readonly [ptyBindingPersistenceOperationsContext]: PtyBindingPersistenceOperationsContext

  constructor(
    runtime: PtyBindingPersistenceOperationsRuntime,
    sessions: SessionHostPartitionOperations
  ) {
    this[ptyBindingPersistenceOperationsContext] = { runtime, sessions }
  }

  persistPtyBinding(args: PersistPtyBindingArgs, hostId?: string | null): boolean {
    const runtime = this[ptyBindingPersistenceOperationsContext].runtime
    const resolvedHostId = resolveHostId(hostId)
    const session =
      this[ptyBindingPersistenceOperationsContext].sessions.getWorkspaceSession(resolvedHostId)
    const paneKey = `${args.tabId}:${args.leafId}`
    const bindingWorktreeId = args.expectedSourceBinding?.worktreeId ?? args.worktreeId
    const span = startPtyBindingSpan({
      hostKind: parseExecutionHostId(resolvedHostId)?.kind ?? 'local',
      origin: args.origin ?? 'unknown',
      savePending: runtime.writeTimer !== null || runtime.pendingWrite !== null,
      generationGap: runtime.writeGeneration - runtime.lastDurableWriteGeneration
    })
    if (ptyBindingIsRefused(args, session, bindingWorktreeId, paneKey)) {
      span.finish('refused')
      return false
    }
    // A durable reattach needs neither a session clone nor whole-state serialization.
    const verdict = evaluatePtyBindingFastLane(
      args,
      session,
      bindingWorktreeId,
      !runtime.quitFlushStarted && runtime.lastDurableWriteGeneration >= runtime.writeGeneration
    )
    span.setEligibility(verdict)
    if (verdict.eligible) {
      span.finish('fast_lane')
      return true
    }
    try {
      writePtyBinding(this, args, session, resolvedHostId, bindingWorktreeId, paneKey)
    } catch (err) {
      span.finish('threw', err)
      throw err
    }
    span.finish('flushed')
    return true
  }
}

function writePtyBinding(
  owner: PtyBindingPersistenceOperations,
  args: PersistPtyBindingArgs,
  session: WorkspaceSessionState,
  resolvedHostId: ReturnType<typeof resolveHostId>,
  bindingWorktreeId: string,
  paneKey: string
): void {
  const runtime = owner[ptyBindingPersistenceOperationsContext].runtime
  const sessionBeforeBinding = cloneWorkspaceSessionState(session)
  try {
    if (resolvedHostId !== LOCAL_EXECUTION_HOST_ID) {
      runtime.state.workspaceSessionsByHostId = {
        ...runtime.state.workspaceSessionsByHostId,
        [resolvedHostId]: session
      }
    }
    applyPtyBinding(args, session, bindingWorktreeId, paneKey)
    runtime.flushOrThrow()
  } catch (err) {
    if (resolvedHostId === LOCAL_EXECUTION_HOST_ID) {
      runtime.state.workspaceSession = sessionBeforeBinding
    } else {
      runtime.state.workspaceSessionsByHostId = {
        ...runtime.state.workspaceSessionsByHostId,
        [resolvedHostId]: sessionBeforeBinding
      }
    }
    throw err
  }
}

function applyPtyBinding(
  args: PersistPtyBindingArgs,
  session: WorkspaceSessionState,
  bindingWorktreeId: string,
  paneKey: string
): void {
  const reconciledIncarnation =
    args.expectedBinding !== undefined && args.incarnationId !== args.expectedBinding.incarnationId
  let terminalMembershipChanged = false
  let hostAdmittedTabCreated = false
  const advanceTopologyFence = (): void => {
    const repoId = getRepoIdFromWorktreeId(bindingWorktreeId)
    const currentRevision = session.terminalTopologyRevisionByRepoId?.[repoId] ?? 0
    // Why: a split, or a host-admitted tab the renderer has never seen, is itself
    // the authority — with no fence the renderer's pre-create tab list replays
    // over it and the tab is lost even on the repo's first such change.
    const establishesMembershipAuthority =
      args.expectedSourceBinding !== undefined || hostAdmittedTabCreated
    if (
      !reconciledIncarnation &&
      (!terminalMembershipChanged || (currentRevision <= 0 && !establishesMembershipAuthority))
    ) {
      return
    }
    // Why: host-admitted membership or incarnation changes must outrank a stale renderer replay.
    session.terminalTopologyRevisionByRepoId = {
      ...session.terminalTopologyRevisionByRepoId,
      [repoId]: currentRevision + 1
    }
  }
  if (args.incarnationId) {
    session.terminalPtyIncarnationsByPaneKey = {
      ...session.terminalPtyIncarnationsByPaneKey,
      [paneKey]: args.incarnationId
    }
    if (session.terminalSurfaceTombstonesByPaneKey?.[paneKey]) {
      session.terminalSurfaceTombstonesByPaneKey = {
        ...session.terminalSurfaceTombstonesByPaneKey
      }
      delete session.terminalSurfaceTombstonesByPaneKey[paneKey]
    }
  }
  const tabs = session.tabsByWorktree?.[bindingWorktreeId]
  const tab = tabs?.find((t) => t.id === args.tabId)
  if (tab) {
    tab.ptyId = args.ptyId
  } else {
    terminalMembershipChanged = true
    hostAdmittedTabCreated = args.hostAdmittedMembership === true
    // Why: pty:spawn can beat the debounced writer; persist a minimal tab so hydration won't prune the binding as orphaned.
    const nextTabs = [
      ...(tabs ?? []),
      createMinimalPersistedTerminalTab({
        ...args,
        worktreeId: bindingWorktreeId,
        existingTabCount: tabs?.length ?? 0
      })
    ]
    session.tabsByWorktree = {
      ...session.tabsByWorktree,
      [bindingWorktreeId]: nextTabs
    }
    session.activeWorktreeId ??= bindingWorktreeId
    session.activeTabId ??= args.tabId
    session.activeTabIdByWorktree = {
      ...session.activeTabIdByWorktree,
      [bindingWorktreeId]: session.activeTabIdByWorktree?.[bindingWorktreeId] ?? args.tabId
    }
  }
  if (!isTerminalLeafId(args.leafId)) {
    // Why: keep legacy renderer-local pane ids out of durable leaf-keyed layout state after the UUID migration.
    advanceTopologyFence()
    return
  }
  const layout = session.terminalLayoutsByTabId?.[args.tabId]
  if (layout) {
    if (!layout.root) {
      terminalMembershipChanged = true
      // Why: createTab can persist an empty layout before TerminalPane mounts; the sync binding still needs a durable root.
      layout.root = { type: 'leaf', leafId: args.leafId }
      layout.activeLeafId = args.leafId
      layout.expandedLeafId = null
    } else if (!layoutContainsLeafId(layout.root, args.leafId)) {
      terminalMembershipChanged = true
      // Why: splitPane spawns before its snapshot reaches main; add a minimal leaf so a crash can't strand the pane's binding.
      layout.root = {
        type: 'split',
        direction: 'vertical',
        first: cloneLayoutNode(layout.root),
        second: { type: 'leaf', leafId: args.leafId }
      }
      layout.activeLeafId = args.leafId
      if (layout.expandedLeafId && !layoutContainsLeafId(layout.root, layout.expandedLeafId)) {
        layout.expandedLeafId = null
      }
    }
    layout.ptyIdsByLeafId = {
      ...layout.ptyIdsByLeafId,
      [args.leafId]: args.ptyId
    }
  } else {
    terminalMembershipChanged = true
    // Why: first tab spawn — persist a minimal layout so a SIGKILL before the renderer snapshot can't lose ptyIdsByLeafId.
    session.terminalLayoutsByTabId = {
      ...session.terminalLayoutsByTabId,
      [args.tabId]: {
        root: { type: 'leaf', leafId: args.leafId },
        activeLeafId: args.leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [args.leafId]: args.ptyId }
      }
    }
  }
  advanceTopologyFence()
}

export function installPtyBindingPersistenceOperationsContext(
  target: object,
  source: PtyBindingPersistenceOperations
): void {
  Object.defineProperty(target, ptyBindingPersistenceOperationsContext, {
    value: source[ptyBindingPersistenceOperationsContext]
  })
}
