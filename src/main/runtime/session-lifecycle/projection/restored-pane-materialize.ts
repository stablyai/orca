// Starting a saved pane that has no live terminal: a client's first view of a pending row, every
// wake of a slept workspace, and, in the layout-owner build, every trigger that is not a desktop
// window's own restore.

import type { OrcaRuntimeWithAgentSessionResumeOwnership as AgentSessionResume } from './agent-session-resume-ownership'
import type {
  MobileTerminalCommand,
  MobileTerminalResumeCommand
} from '../../terminal/launch/mobile-terminal-startup'
import { OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs } from './build-headless-mobile-session-browser-tabs'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { isUnclaimedRunningSleepRecord, markResumedRecordLive } from './sleep-record-pane-claim'
import { isWorktreeTerminalsSleepingError } from '../../worktree-terminals-sleeping-error'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch-runtime'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-types'
import { buildHeadlessMobileSessionTerminalTabs } from '../../mobile-session-terminal-projection'
import {
  RestoredPaneStarter,
  type RestoredPane,
  type StartedPty,
  type RestoredPaneTrigger
} from '../../terminal/recovery/restored-pane-start'
import { isPublishedHeld, reopenHeldPanes } from '../../terminal/recovery/held-pane-reopen'
import { reopenNewerDaemonTerminals } from '../../../daemon/daemon-newer-protocol-hold'
import type { NewerDaemonReopenResult } from '../../../../shared/newer-daemon-hold'
import type { WorkspaceLayoutStream } from '../../workspace-layout-stream'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'

export abstract class OrcaRuntimeWithRestoredPaneStart extends OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs {
  protected abstract resolveAgentLaunchRuntime(
    scope: TerminalWorkspaceLaunchScope,
    agent: TuiAgent | undefined
  ): AgentLaunchRuntime
  protected abstract resolvePaneOwnedResumeStartup(
    ...args: Parameters<AgentSessionResume['resolvePaneOwnedResumeStartup']>
  ): ReturnType<AgentSessionResume['resolvePaneOwnedResumeStartup']>
  protected abstract commitWorkspaceSessionEdit(
    ...args: Parameters<AgentSessionResume['commitWorkspaceSessionEdit']>
  ): ReturnType<AgentSessionResume['commitWorkspaceSessionEdit']>

  abstract subscribeWorkspaceLayouts(
    listener: Parameters<WorkspaceLayoutStream['subscribe']>[0]
  ): ReturnType<WorkspaceLayoutStream['subscribe']>

  private restoredPanes: RestoredPaneStarter | null = null

  /** Publishes the pane's start status (layout-owner build): starting, or failed with its reason. */
  protected abstract showRestoredPaneStart(
    paneKey: string,
    start: 'starting' | { failed: unknown }
  ): void

  /**
   * The pane's live terminal, started once if it has none: every wake of a slept pane, and in the
   * layout-owner build any trigger but a desktop window's own restore. Null when main no longer
   * holds the pane.
   */
  ensureRestoredPaneStarted(
    pane: RestoredPane,
    trigger: RestoredPaneTrigger = {}
  ): Promise<StartedPty | null> {
    this.restoredPanes ??= new RestoredPaneStarter({
      boundPtyId: (target) => this.storedPaneBinding(target),
      isLive: (ptyId) => this.ptysById.get(ptyId)?.connected === true,
      starting: (target) =>
        this.showRestoredPaneStart(`${target.tabId}:${target.leafId}`, 'starting'),
      failed: (target, error) =>
        this.showRestoredPaneStart(`${target.tabId}:${target.leafId}`, { failed: error }),
      start: async (target, plan, startTrigger) => {
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(target.worktreeId)
        // Why main's layout, not the client projection: at relaunch a window's view can ask before
        // its graph lists the tab, and the projection is not built while a window is attached.
        const session = this.getWorkspaceSessionForWorktree(target.worktreeId)
        const tab = session
          ? buildHeadlessMobileSessionTerminalTabs(
              target.worktreeId,
              session.tabsByWorktree?.[target.worktreeId] ?? [],
              session
            ).find(
              (candidate) =>
                candidate.parentTabId === target.tabId && candidate.leafId === target.leafId
            )
          : undefined
        if (!tab) {
          throw new Error('tab_not_found')
        }
        const started = await this.materializePendingMobileSessionTerminal(target.worktreeId, tab, {
          ...startTrigger,
          sessionId: plan.sessionId
        })
        // Why: the started id, not the stored layout, whose bind write may still be in flight.
        // Resolved only once registered, so a caller delivering to it never misses (A1's handles).
        if (!started.tab.ptyId || !this.ptysById.has(started.tab.ptyId)) {
          throw new Error('terminal_not_started')
        }
        return { id: started.tab.ptyId, startupCwdFallback: started.startupCwdFallback }
      }
    })
    return this.restoredPanes.ensureStarted(pane, trigger)
  }

  /**
   * A wake: resumes, each in its own pane, the agents a workspace slept while they ran. Settles
   * once every start has; a pane whose tab has since closed starts nothing.
   */
  async resumeSleptWorkspaceAgents(worktreeId: string): Promise<void> {
    const records = Object.values(
      this.getWorkspaceSessionForWorktree(worktreeId)?.sleepingAgentSessionsByPaneKey ?? {}
    ).filter(
      (record) =>
        worktreeIdsEqual(record.worktreeId, worktreeId) && isUnclaimedRunningSleepRecord(record)
    )
    const panes = records.flatMap((record) => {
      const pane = parsePaneKey(record.paneKey)
      return pane ? [{ worktreeId, tabId: pane.tabId, leafId: pane.leafId }] : []
    })
    const started = await Promise.allSettled(
      panes.map((pane) => this.ensureRestoredPaneStarted(pane))
    )
    for (const result of started) {
      if (result.status === 'rejected') {
        console.warn('[runtime] slept agent resume failed', result.reason)
      }
    }
  }

  /** Main is stopping this terminal to restart its pane: its earlier start no longer stands. */
  forgetRestoredPaneStart(ptyId: string): void {
    this.restoredPanes?.forget(ptyId)
  }

  /** Whether main's layout binds the pane to this terminal now: a view's ack names its current one. */
  isRestoredPaneBoundTo(pane: RestoredPane, ptyId: string): boolean {
    return this.storedPaneBinding(pane) === ptyId
  }

  /** Layout-owner build: a paired desktop's Reopen of the panes main publishes held. */
  reopenHeldTerminalPanes(panes: readonly RestoredPane[]): Promise<NewerDaemonReopenResult> {
    // Why the published layout: its status is the one the desktop's banner showed.
    const { snapshot, unsubscribe } = this.subscribeWorkspaceLayouts(() => {})
    unsubscribe()
    const published = snapshot.map((entry) => entry.layout)
    return reopenHeldPanes(panes, {
      isHeld: (pane) => isPublishedHeld(published, pane),
      stopNewerDaemons: () => reopenNewerDaemonTerminals().then((result) => result.reopened),
      start: async (pane) => (await this.ensureRestoredPaneStarted(pane))?.id ?? null
    })
  }

  /** The pane's stored terminal; undefined while unbound, null once main no longer holds it. */
  private storedPaneBinding({
    worktreeId,
    tabId,
    leafId
  }: RestoredPane): string | null | undefined {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    const row = session?.tabsByWorktree?.[worktreeId]?.find((candidate) => candidate.id === tabId)
    if (!row) {
      return null
    }
    const layout = session?.terminalLayoutsByTabId?.[tabId]
    // Why: a tab saved with no layout is one pane, the one the projection lists for it.
    return layout ? layout.ptyIdsByLeafId?.[leafId] : (row.ptyId ?? undefined)
  }

  /** Starts a pending terminal row in its own pane, resuming the agent the host recorded there. */
  protected async materializePendingMobileSessionTerminal(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    {
      automatic = false,
      targetsHost = false,
      targetGroupId,
      sessionId
    }: RestoredPaneTrigger & { sessionId?: string }
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    // Why: a pending agent tab may exist without its startup command ever
    // having been delivered (the create's renderer stalled, #7587), so a
    // bare materialize would put a plain shell under the agent icon.
    // Re-resolve the launch like the create path; providers skip startup
    // commands when attaching to live sessions, so this cannot double-launch.
    // Why: an agent already ran here and the host recorded its session; resume it rather than
    // start a bare shell or a fresh agent (#27147, #27777).
    const resumeStartup = await this.resolvePaneOwnedResumeStartup(worktreeId, tab)
    // Switch point: the record a resume starts from (after any claim), marked live once it runs.
    const paneKey = `${tab.parentTabId}:${tab.leafId}`
    const resumedRecord =
      ORCA_LAYOUT_OWNER_IS_MAIN && resumeStartup && 'resumeProviderSession' in resumeStartup
        ? this.getWorkspaceSessionForWorktree(worktreeId)?.sleepingAgentSessionsByPaneKey?.[paneKey]
        : undefined
    let agentStartup: MobileTerminalCommand | MobileTerminalResumeCommand = resumeStartup ?? {}
    const resumeClaim =
      resumeStartup && 'resumeClaim' in resumeStartup ? resumeStartup.resumeClaim : null
    if (resumeStartup === undefined && tab.launchAgent) {
      let workspace
      try {
        workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
        agentStartup = await this.resolveMobileSessionTerminalCommand(workspace, {
          agent: tab.launchAgent
        })
      } catch {
        // Why: a disabled or unresolvable agent must not make the tab
        // untappable; fall back to the plain-shell materialize. A runtime that needs repair
        // rethrows its message here instead of leaving a plain shell under the agent icon.
        if (workspace) {
          this.resolveAgentLaunchRuntime(workspace, tab.launchAgent)
        }
      }
    }
    let dispatched = false
    try {
      const created = await this.createRuntimeOwnedMobileSessionTerminal(
        worktreeId,
        targetsHost,
        undefined,
        {
          identity: {
            tabId: tab.parentTabId,
            leafId: tab.leafId,
            sessionId
          },
          cwd: tab.startupCwd,
          command: agentStartup.command,
          env: agentStartup.env,
          startupCommandDelivery: agentStartup.startupCommandDelivery,
          launchConfig: agentStartup.launchConfig,
          launchAgent: agentStartup.launchAgent ?? tab.launchAgent,
          // Why: a resume is restore work, so the host's restore admission must see it.
          ...('resumeProviderSession' in agentStartup
            ? {
                resumeProviderSession: agentStartup.resumeProviderSession,
                spawnIntent: automatic ? 'automatic-restore' : 'user-resume'
              }
            : {}),
          launchRuntime: agentStartup.launchRuntime,
          targetGroupId,
          onPtySpawnDispatched: () => {
            dispatched = true
          },
          ...(resumeClaim ? { onPtyCreated: resumeClaim.bind } : {}),
          ...(automatic ? { refuseSleptWorktree: true } : {}),
          // Switch point: only a start from the pane's own record shows the window's banner.
          ...(resumedRecord ? { resumesSleepingRecord: true as const } : {})
        }
      )
      // Switch point: under main the resumed agent runs, so its record must not read as a sleep.
      if (created.tab.ptyId && resumedRecord) {
        const hostId = this.getWorkspaceSessionHostIdForWorktree(worktreeId)
        void markResumedRecordLive(
          (edit) => this.commitWorkspaceSessionEdit(hostId, edit),
          paneKey,
          resumedRecord
        ).catch((err: unknown) => console.warn('[layout] could not mark a resumed pane live', err))
      }
      return created
    } catch (err) {
      resumeClaim?.settleFailure(dispatched, err)
      if (
        !(automatic && isWorktreeTerminalsSleepingError(err)) &&
        sessionId &&
        parseAppSshPtyId(sessionId)
      ) {
        // Why: an expired SSH reattach clears durable bindings in the store,
        // but this in-memory headless snapshot can still carry the old id.
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, { force: true })
      }
      throw err
    }
  }
}
