import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { RetainedTerminalStart } from '../../../../shared/workspace-layout/retained-terminal-start'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../shared/workspace-layout/terminal-tab-types'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-pane-layout-tree'
import type { PaneStartFact, RetainedStartBinding } from './pane-start-statuses'

type Session = WorkspaceSessionState | null | undefined
type Revision = {
  tabs: WorkspaceSessionState['tabsByWorktree'] | undefined
  layouts: WorkspaceSessionState['terminalLayoutsByTabId'] | undefined
  incarnations: WorkspaceSessionState['terminalPtyIncarnationsByPaneKey']
  tombstones: WorkspaceSessionState['terminalSurfaceTombstonesByPaneKey']
  closedTabs: WorkspaceSessionState['closedTerminalTabTombstonesByTabId']
  closedPanes: WorkspaceSessionState['closedTerminalPanesByPaneKey']
}

/** Reference checks are constant on scalar writes; addressed lookups share each topology index. */
export class RetainedTerminalSessionIndex {
  private readonly revisions = new Map<ExecutionHostId, Revision>()
  private readonly tabIndices = new WeakMap<TerminalTab[], Map<string, TerminalTab>>()
  private readonly leaves = new WeakMap<TerminalLayoutSnapshot['root'] & object, Set<string>>()

  constructor(private readonly readSession: (hostId: ExecutionHostId) => Session) {}

  revision(hostId: ExecutionHostId): Revision {
    const session = this.readSession(hostId)
    const previous = this.revisions.get(hostId)
    const next: Revision = {
      tabs: session?.tabsByWorktree,
      layouts: session?.terminalLayoutsByTabId,
      incarnations: session?.terminalPtyIncarnationsByPaneKey,
      tombstones: session?.terminalSurfaceTombstonesByPaneKey,
      closedTabs: session?.closedTerminalTabTombstonesByTabId,
      closedPanes: session?.closedTerminalPanesByPaneKey
    }
    if (
      previous &&
      previous.tabs === next.tabs &&
      previous.layouts === next.layouts &&
      previous.incarnations === next.incarnations &&
      previous.tombstones === next.tombstones &&
      previous.closedTabs === next.closedTabs &&
      previous.closedPanes === next.closedPanes
    ) {
      return previous
    }
    this.revisions.set(hostId, next)
    return next
  }

  clear(): void {
    this.revisions.clear()
  }

  forget(hostId: ExecutionHostId): void {
    this.revisions.delete(hostId)
  }

  binding(
    start: RetainedTerminalStart,
    revision = this.revision(start.executionHostId)
  ): RetainedStartBinding {
    const tab = this.tab(start, revision)
    const layout = revision.layouts?.[start.tabId]
    return {
      ptyId:
        layout?.ptyIdsByLeafId?.[start.leafId] ??
        (layout?.root?.type === 'leaf' && layout.root.leafId === start.leafId
          ? tab?.ptyId
          : null) ??
        null,
      ...(revision.incarnations?.[`${start.tabId}:${start.leafId}`]
        ? { incarnationId: revision.incarnations[`${start.tabId}:${start.leafId}`] }
        : {})
    }
  }

  isCurrent(fact: PaneStartFact, revision?: Revision): boolean {
    const start = fact.retainedTerminalStart
    if (!start) {
      return false
    }
    revision ??= this.revision(start.executionHostId)
    const layout = revision.layouts?.[start.tabId]
    const key = `${start.tabId}:${start.leafId}`
    if (
      !this.tab(start, revision) ||
      !layout?.root ||
      revision.closedTabs?.[start.tabId] ||
      revision.tombstones?.[key] ||
      revision.closedPanes?.[key]
    ) {
      return false
    }
    let leaves = this.leaves.get(layout.root)
    if (!leaves) {
      leaves = new Set(collectLeafIds(layout.root))
      this.leaves.set(layout.root, leaves)
    }
    if (!leaves.has(start.leafId)) {
      return false
    }
    const before = fact.retainedStartBinding
    const current = this.binding(start, revision)
    // Retiring an old hint is not a newly accepted binding; accepted settlement clears explicitly.
    return (
      !before ||
      current.ptyId === null ||
      (current.ptyId === before.ptyId && current.incarnationId === before.incarnationId)
    )
  }

  tab(start: RetainedTerminalStart, revision: Revision): TerminalTab | undefined {
    const tabs = revision.tabs?.[start.worktreeId]
    if (!tabs) {
      return undefined
    }
    let index = this.tabIndices.get(tabs)
    if (!index) {
      index = new Map(tabs.map((tab) => [tab.id, tab]))
      this.tabIndices.set(tabs, index)
    }
    return index.get(start.tabId)
  }
}
