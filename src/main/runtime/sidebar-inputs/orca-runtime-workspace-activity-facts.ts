import { OrcaRuntimeWithAgentTransitions } from '../orca-runtime-agent-transitions'
import type { PtyLivenessVerdict } from '../../../shared/pty-liveness-verdict'
import type {
  WorkspaceActivityFactsSnapshot,
  WorkspaceTerminalLiveness
} from '../../../shared/sidebar-list/workspace-activity-facts'
import { worktreeIdentityKey } from '../../../shared/worktree/id'
import { SidebarClock } from './sidebar-clock'
import {
  WorkspaceActivityFactsProducer,
  type WorkspaceSurfaceActivity
} from './workspace-activity-facts-producer'

type Runtime = OrcaRuntimeWithAgentTransitions

/**
 * Feeds the activity producer from the runtime's own funnels: every per-workspace session.tabs
 * publication (already coalesced, and fired for status-only changes too), the graph sync that
 * replaces the tabs agent rows are attributed through, and the PTY liveness writers no
 * publication follows: exits, verdicts and the inventory sweep.
 */
export abstract class OrcaRuntimeWithWorkspaceActivityFacts extends OrcaRuntimeWithAgentTransitions {
  readonly sidebarClock = new SidebarClock()
  readonly workspaceActivityFacts = new WorkspaceActivityFactsProducer({
    readSurfaces: (worktreeId) => this.readWorkspaceSurfaceActivity(worktreeId),
    resolveTabWorktreeId: (tabId) => this.tabs.get(tabId)?.worktreeId,
    clock: this.sidebarClock
  })

  getWorkspaceActivityFacts(): WorkspaceActivityFactsSnapshot {
    return this.workspaceActivityFacts.snapshot()
  }

  override syncWindowGraph(...args: Parameters<Runtime['syncWindowGraph']>) {
    const previousTabs = this.tabs
    const previousLeaves = this.leaves
    const result = super.syncWindowGraph(...args)
    // Only a tab moving workspace can change where an agent row is attributed.
    const moved = [...this.tabs.values()].some(
      (tab) => previousTabs.get(tab.tabId)?.worktreeId !== tab.worktreeId
    )
    if (moved || [...previousTabs.keys()].some((tabId) => !this.tabs.has(tabId))) {
      this.workspaceActivityFacts.resyncAgentPanes()
    }
    // Now, not on the session publication: a closed pane's stopping PTY stops counting here.
    // syncWindowGraph replaces this.leaves (session-window-graph.ts), so previousLeaves stays intact.
    this.refreshWorkspaces(leafPtyChangedWorktrees(previousLeaves, this.leaves))
    return result
  }

  override markPtyStopRequested(ptyId: string): void {
    super.markPtyStopRequested(ptyId)
    this.refreshWorkspaces(this.ptyWorktreeIds(ptyId))
  }

  override clearPtyStopRequest(ptyId: string): void {
    super.clearPtyStopRequest(ptyId)
    this.refreshWorkspaces(this.ptyWorktreeIds(ptyId))
  }

  protected override notifyMobileSessionTabsChangedNow(
    worktreeId: string,
    changeSequence: number
  ): void {
    super.notifyMobileSessionTabsChangedNow(worktreeId, changeSequence)
    this.workspaceActivityFacts.refreshWorkspace(worktreeId)
  }

  protected override notifyMobileSessionTabSnapshots(): void {
    super.notifyMobileSessionTabSnapshots()
    for (const worktreeId of this.mobileSessionTabsByWorktree.keys()) {
      this.workspaceActivityFacts.refreshWorkspace(worktreeId)
    }
  }

  protected override notifyMobileSessionTabsRemoved(worktreeId: string): void {
    super.notifyMobileSessionTabsRemoved(worktreeId)
    this.workspaceActivityFacts.refreshWorkspace(worktreeId)
  }

  override onPtyExit(...args: Parameters<Runtime['onPtyExit']>): ReturnType<Runtime['onPtyExit']> {
    // Read first: the exit may prune the PTY's record.
    const worktreeIds = this.ptyWorktreeIds(args[0])
    const result = super.onPtyExit(...args)
    this.refreshWorkspaces(worktreeIds)
    return result
  }

  protected override rememberPtyLivenessVerdict(ptyId: string, verdict: PtyLivenessVerdict): void {
    const before = this.getPtyLivenessVerdict(ptyId)?.status
    super.rememberPtyLivenessVerdict(ptyId, verdict)
    // An inventory sweep re-confirms every PTY; only a changed verdict can change a fact.
    if (before !== verdict.status) {
      this.refreshWorkspaces(this.ptyWorktreeIds(ptyId))
    }
  }

  protected override async refreshPtyWorktreeRecordsWithControllerInventory(
    ...args: Parameters<Runtime['refreshPtyWorktreeRecordsWithControllerInventory']>
  ): ReturnType<Runtime['refreshPtyWorktreeRecordsWithControllerInventory']> {
    const livenessOf = (ptyId: string, connected: boolean): string =>
      `${connected}:${this.getPtyLivenessVerdict(ptyId)?.status ?? ''}`
    const before = new Map(
      [...this.ptysById].map(([id, pty]) => [id, livenessOf(id, pty.connected)])
    )
    try {
      return await super.refreshPtyWorktreeRecordsWithControllerInventory(...args)
    } finally {
      const changed = new Set<string>()
      for (const pty of this.ptysById.values()) {
        if (before.get(pty.ptyId) !== livenessOf(pty.ptyId, pty.connected)) {
          changed.add(pty.worktreeId)
        }
      }
      this.refreshWorkspaces(changed)
    }
  }

  // Asked to stop with no pane left: the window that closed it already shows it gone.
  private isClosing(ptyId: string): boolean {
    return this.isPtyStopRequested(ptyId) && this.getLeavesForPty(ptyId).length === 0
  }

  private ptyWorktreeIds(ptyId: string): Set<string> {
    const worktreeIds = new Set(this.getLeavesForPty(ptyId).map((leaf) => leaf.worktreeId))
    const recorded = this.ptysById.get(ptyId)?.worktreeId
    return recorded ? worktreeIds.add(recorded) : worktreeIds
  }

  private refreshWorkspaces(worktreeIds: Iterable<string>): void {
    for (const worktreeId of worktreeIds) {
      this.workspaceActivityFacts.refreshWorkspace(worktreeId)
    }
  }

  private readWorkspaceSurfaceActivity(worktreeId: string): WorkspaceSurfaceActivity {
    const tabs = this.mobileSessionTabsByWorktree.get(worktreeId)?.tabs ?? []
    return {
      terminal: this.readWorkspaceTerminalLiveness(worktreeId),
      browser: tabs.some((tab) => tab.type === 'browser'),
      structuredChat: tabs.some((tab) => tab.type === 'agent-session')
    }
  }

  // Matches every host form of the worktree's id. A host that only lost contact keeps its terminals
  // unverifiable, never gone, even while the record still reads connected or is being closed.
  private readWorkspaceTerminalLiveness(worktreeId: string): WorkspaceTerminalLiveness | null {
    const key = worktreeIdentityKey(worktreeId)
    const owns = (id: string): boolean => id === worktreeId || worktreeIdentityKey(id) === key
    let unverifiable = false
    for (const surfaces of [this.leaves.values(), this.ptysById.values()]) {
      for (const surface of surfaces) {
        if (surface.ptyId === null || !owns(surface.worktreeId)) {
          continue
        }
        if (this.getPtyLivenessVerdict(surface.ptyId)?.status === 'unverifiable') {
          unverifiable = true
        } else if (surface.connected && !this.isClosing(surface.ptyId)) {
          return 'live'
        }
      }
    }
    return unverifiable ? 'unverifiable' : null
  }
}

function leafPtyChangedWorktrees(
  before: ReadonlyMap<string, { worktreeId: string; ptyId: string | null }>,
  after: ReadonlyMap<string, { worktreeId: string; ptyId: string | null }>
): Set<string> {
  const changed = new Set<string>()
  for (const [leafId, leaf] of before) {
    const next = after.get(leafId)
    if (next?.ptyId !== leaf.ptyId || next.worktreeId !== leaf.worktreeId) {
      changed.add(leaf.worktreeId)
    }
  }
  for (const [leafId, leaf] of after) {
    const previous = before.get(leafId)
    if (previous?.ptyId !== leaf.ptyId || previous.worktreeId !== leaf.worktreeId) {
      changed.add(leaf.worktreeId)
    }
  }
  return changed
}
