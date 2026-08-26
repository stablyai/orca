import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
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

type PtyBindingPersistenceOperationsRuntime = Pick<StoreRuntimeState, 'flushOrThrow' | 'state'>

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

  persistPtyBinding(
    args: {
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
    },
    hostId?: string | null
  ): boolean {
    const resolvedHostId = resolveHostId(hostId)
    const session =
      this[ptyBindingPersistenceOperationsContext].sessions.getWorkspaceSession(resolvedHostId)
    const paneKey = `${args.tabId}:${args.leafId}`
    const bindingWorktreeId = args.expectedSourceBinding?.worktreeId ?? args.worktreeId
    if (args.expectedSourceBinding) {
      const expected = args.expectedSourceBinding
      if (expected.tabId !== args.tabId) {
        return false
      }
      const sourceTab = session.tabsByWorktree?.[bindingWorktreeId]?.find(
        (candidate) => candidate.id === expected.tabId && candidate.worktreeId === bindingWorktreeId
      )
      const sourceLayout = session.terminalLayoutsByTabId?.[expected.tabId]
      const sourcePaneKey = `${expected.tabId}:${expected.leafId}`
      if (
        !sourceTab ||
        sourceLayout?.ptyIdsByLeafId?.[expected.leafId] !== expected.ptyId ||
        !layoutContainsLeafId(sourceLayout.root, expected.leafId) ||
        (expected.incarnationId !== undefined &&
          session.terminalPtyIncarnationsByPaneKey?.[sourcePaneKey] !== expected.incarnationId)
      ) {
        return false
      }
    }
    if (args.expectedBinding) {
      const tab = session.tabsByWorktree?.[bindingWorktreeId]?.find(
        (candidate) => candidate.id === args.tabId && candidate.worktreeId === bindingWorktreeId
      )
      const boundPtyId = session.terminalLayoutsByTabId?.[args.tabId]?.ptyIdsByLeafId?.[args.leafId]
      if (
        !tab ||
        boundPtyId !== args.expectedBinding.ptyId ||
        session.terminalPtyIncarnationsByPaneKey?.[paneKey] !== args.expectedBinding.incarnationId
      ) {
        return false
      }
    }
    if (resolvedHostId !== LOCAL_EXECUTION_HOST_ID) {
      this[ptyBindingPersistenceOperationsContext].runtime.state.workspaceSessionsByHostId = {
        ...this[ptyBindingPersistenceOperationsContext].runtime.state.workspaceSessionsByHostId,
        [resolvedHostId]: session
      }
    }
    const sessionBeforeBinding = cloneWorkspaceSessionState(session)
    const reconciledIncarnation =
      args.expectedBinding !== undefined &&
      args.incarnationId !== args.expectedBinding.incarnationId
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
    const restoreSession = (): void => {
      if (resolvedHostId === LOCAL_EXECUTION_HOST_ID) {
        this[ptyBindingPersistenceOperationsContext].runtime.state.workspaceSession =
          sessionBeforeBinding
      } else {
        this[ptyBindingPersistenceOperationsContext].runtime.state.workspaceSessionsByHostId = {
          ...this[ptyBindingPersistenceOperationsContext].runtime.state.workspaceSessionsByHostId,
          [resolvedHostId]: sessionBeforeBinding
        }
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
      try {
        this[ptyBindingPersistenceOperationsContext].runtime.flushOrThrow()
      } catch (err) {
        restoreSession()
        throw err
      }
      return true
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
    try {
      this[ptyBindingPersistenceOperationsContext].runtime.flushOrThrow()
    } catch (err) {
      restoreSession()
      throw err
    }
    return true
  }
}

export function installPtyBindingPersistenceOperationsContext(
  target: object,
  source: PtyBindingPersistenceOperations
): void {
  Object.defineProperty(target, ptyBindingPersistenceOperationsContext, {
    value: source[ptyBindingPersistenceOperationsContext]
  })
}
