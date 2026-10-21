// Starting a saved pane that has no live terminal: a client's first view of a pending row, and,
// in the layout-owner build, every trigger that is not a desktop window's own restore.

import type { OrcaRuntimeWithApplyMobileSessionTabNavigation as MobileSessionNavigation } from './apply-mobile-session-tab-navigation'
import type {
  MobileTerminalCommand,
  MobileTerminalResumeCommand
} from '../../terminal/launch/mobile-terminal-startup'
import { OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs } from './build-headless-mobile-session-browser-tabs'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { isWorktreeTerminalsSleepingError } from '../../worktree-terminals-sleeping-error'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch-runtime'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-types'
import {
  RestoredPaneStarter,
  type RestoredPane,
  type RestoredPaneTrigger
} from '../../terminal/recovery/restored-pane-start'
import { isPublishedHeld, reopenHeldPanes } from '../../terminal/recovery/held-pane-reopen'
import { reopenNewerDaemonTerminals } from '../../../daemon/daemon-newer-protocol-hold'
import type { NewerDaemonReopenResult } from '../../../../shared/newer-daemon-hold'
import type { WorkspaceLayoutStream } from '../../workspace-layout-stream'

export abstract class OrcaRuntimeWithRestoredPaneStart extends OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs {
  protected abstract resolveAgentLaunchRuntime(
    scope: TerminalWorkspaceLaunchScope,
    agent: TuiAgent | undefined
  ): AgentLaunchRuntime
  protected abstract resolvePaneOwnedResumeStartup(
    ...args: Parameters<MobileSessionNavigation['resolvePaneOwnedResumeStartup']>
  ): ReturnType<MobileSessionNavigation['resolvePaneOwnedResumeStartup']>

  abstract subscribeWorkspaceLayouts(
    listener: Parameters<WorkspaceLayoutStream['subscribe']>[0]
  ): ReturnType<WorkspaceLayoutStream['subscribe']>

  private restoredPanes: RestoredPaneStarter | null = null

  /**
   * Layout-owner build: the pane's live terminal, started once if it has none, for any trigger
   * but a desktop window's own restore. Null when main no longer holds the pane.
   */
  ensureRestoredPaneStarted(
    pane: RestoredPane,
    trigger: RestoredPaneTrigger = {}
  ): Promise<string | null> {
    this.restoredPanes ??= new RestoredPaneStarter({
      boundPtyId: (target) => this.storedPaneBinding(target),
      isLive: (ptyId) => this.ptysById.get(ptyId)?.connected === true,
      start: async (target, plan, startTrigger) => {
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(target.worktreeId)
        const tab = this.mobileSessionTabsByWorktree
          .get(target.worktreeId)
          ?.tabs.find(
            (candidate): candidate is RuntimeMobileSessionTerminalTab =>
              candidate.type === 'terminal' &&
              candidate.parentTabId === target.tabId &&
              candidate.leafId === target.leafId
          )
        if (!tab) {
          throw new Error('tab_not_found')
        }
        const started = await this.materializePendingMobileSessionTerminal(target.worktreeId, tab, {
          ...startTrigger,
          sessionId: plan.sessionId
        })
        // Why: the started id, not the stored layout, whose bind write may still be in flight.
        // Resolved only once registered, so a caller delivering to it never misses (A1's handles).
        if (!started || !this.ptysById.has(started)) {
          throw new Error('terminal_not_started')
        }
        return started
      }
    })
    return this.restoredPanes.ensureStarted(pane, trigger)
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
      start: (pane) => this.ensureRestoredPaneStarted(pane)
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
  ): Promise<string | null> {
    // Why: a pending agent tab may exist without its startup command ever
    // having been delivered (the create's renderer stalled, #7587), so a
    // bare materialize would put a plain shell under the agent icon.
    // Re-resolve the launch like the create path; providers skip startup
    // commands when attaching to live sessions, so this cannot double-launch.
    // Why: an agent already ran here and the host recorded its session; resume it rather than
    // start a bare shell or a fresh agent (#27147, #27777).
    const resumeStartup = await this.resolvePaneOwnedResumeStartup(worktreeId, tab)
    let agentStartup: MobileTerminalCommand | MobileTerminalResumeCommand = resumeStartup ?? {}
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
          ...(automatic ? { refuseSleptWorktree: true } : {})
        }
      )
      return created.tab.ptyId ?? null
    } catch (err) {
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
