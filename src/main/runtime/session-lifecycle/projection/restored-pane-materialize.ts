// Restore terminal-less saved panes for pending-row activation and workspace wakes; main-owned layouts also handle triggers outside desktop restore.

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
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
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
import { getDaemonHistoryDir } from '../../../daemon/daemon-launch-paths'
import { HistoryReader } from '../../../daemon/history-reader'
import { servesWslMovedPaneHistory } from '../../../orcad/orcad-migration-wsl-destination'
import { movedPaneHistorySessionId } from '../../../persistence/migrating-orcad-catalog/orcad-terminal-history-installer'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
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

  /** Start once if no terminal exists; all workspace wakes and non-window restore triggers use this in main-owned layouts. Null if main no longer holds the pane. */
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
        // Read main's layout: relaunch clients may ask before graph sync, and projections are absent while a window is attached.
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
        // Use the registered start id; its durable bind may still be in flight, but delivery must already resolve its handle.
        if (!started.tab.ptyId || !this.ptysById.has(started.tab.ptyId)) {
          throw new Error('terminal_not_started')
        }
        return { id: started.tab.ptyId, startupCwdFallback: started.startupCwdFallback }
      }
    })
    return this.restoredPanes.ensureStarted(pane, trigger)
  }

  /** Resume slept agents in their own panes and await every start; tabs closed in the meantime start nothing. */
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

  /**
   * The session a WSL move installed for this pane (its carried checkpoint, interrupted), so its
   * first start cold-restores that history once like after an app restart; undefined otherwise.
   */
  private async claimMovedPaneHistorySession({
    worktreeId,
    tabId,
    leafId
  }: RestoredPane): Promise<string | undefined> {
    // Only a WSL host installs moved panes' history; other hosts skip the scope and meta.json reads.
    if (!servesWslMovedPaneHistory()) {
      return undefined
    }
    try {
      const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
      // Why never over SSH: only this host's own daemon holds the installed history.
      if (workspace.connectionId !== null) {
        return undefined
      }
      const sessionId = movedPaneHistorySessionId(worktreeId, makePaneKey(tabId, leafId))
      const probe = new HistoryReader(getDaemonHistoryDir()).probeRestorableHistory(sessionId)
      return probe.status === 'restorable' ? sessionId : undefined
    } catch {
      // Why: history is best effort; the pane still starts, only without what it showed before.
      return undefined
    }
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
    // Recover undelivered startup commands (#7587) or recorded agent sessions (#27147, #27777); live-session attach skips startup commands, preventing double launches.
    const resumeStartup = await this.resolvePaneOwnedResumeStartup(worktreeId, tab)
    // After a claimed-record resume starts, mark that record live.
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
        // Disabled/unresolvable agents fall back to a tappable shell; runtime repair errors still refuse rather than hide failure under an agent icon.
        if (workspace) {
          this.resolveAgentLaunchRuntime(workspace, tab.launchAgent)
        }
      }
    }
    let dispatched = false
    try {
      const startSessionId =
        sessionId ??
        (await this.claimMovedPaneHistorySession({
          worktreeId,
          tabId: tab.parentTabId,
          leafId: tab.leafId
        }))
      const created = await this.createRuntimeOwnedMobileSessionTerminal(
        worktreeId,
        targetsHost,
        undefined,
        {
          identity: {
            tabId: tab.parentTabId,
            leafId: tab.leafId,
            sessionId: startSessionId
          },
          cwd: tab.startupCwd,
          command: agentStartup.command,
          env: agentStartup.env,
          startupCommandDelivery: agentStartup.startupCommandDelivery,
          launchConfig: agentStartup.launchConfig,
          launchAgent: agentStartup.launchAgent ?? tab.launchAgent,
          // Restore admission must authorize resumes too.
          ...('resumeProviderSession' in agentStartup
            ? {
                resumeProviderSession: agentStartup.resumeProviderSession,
                resumeOrigin: 'saved' as const,
                spawnIntent: automatic ? 'automatic-restore' : 'user-resume'
              }
            : {}),
          launchRuntime: agentStartup.launchRuntime,
          targetGroupId,
          onPtySpawnDispatched: () => {
            dispatched = true
          },
          ...(resumeClaim
            ? {
                onPtyCreated: (ptyId: string, result: RuntimeTerminalCreate) => {
                  const decision = result.savedResumeDecision
                  if (
                    !result.isReattach &&
                    result.agentSessionDisposition !== 'adopted' &&
                    decision &&
                    decision.agent === resumeStartup?.launchAgent &&
                    decision.verdict !== 'admitted' &&
                    decision.verdict === result.agentResumeRefused &&
                    agentProviderSessionsEqual(
                      decision.agent,
                      decision.providerSession,
                      resumeStartup?.resumeProviderSession
                    )
                  ) {
                    resumeClaim.settleFailure(false)
                  } else {
                    resumeClaim.bind(ptyId)
                  }
                }
              }
            : {}),
          ...(automatic ? { refuseSleptWorktree: true } : {}),
          // Only resumes from this pane's record show the window banner.
          ...(resumedRecord ? { resumesSleepingRecord: true as const } : {})
        }
      )
      // A running resumed agent's record must not remain asleep.
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
        // Expired SSH reattach clears durable bindings before this headless snapshot necessarily drops the old id.
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, { force: true })
      }
      throw err
    }
  }
}
