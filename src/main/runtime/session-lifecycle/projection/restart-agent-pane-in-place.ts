import { OrcaRuntimeWithResumeAgentSessionInWorkspace } from './resume-agent-session-in-workspace'
import { retireReplacedPaneBinding } from '../../../ipc/pty/pane/pane-owner-replacement'
import { makePaneKey, parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { WorktreeSleepResumeRecorder } from '../../terminal/stop/worktree-sleep-resume-records'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentSessionResumeClaim } from './agent-session-resume-claims'

export type AgentPaneRestartRefusal =
  /** Not a live terminal of this host's own (an SSH relay or another server's pane). */
  | 'not_local'
  /** A client viewing the pane would be left on a dead pane by an older Orca. */
  | 'viewer_cannot_follow'
  | 'no_resume_command'
  | 'busy'
  /** The stop was sent but its exit unconfirmed: the terminal may still end, with no replacement. */
  | 'stop_failed'
  /** Stopped, but no new terminal took the pane: it is left as a slept pane, so its next view
   *  starts it afresh and resumes the conversation. */
  | 'create_failed'

export type AgentPaneRestartResult =
  | { ok: true; ptyId: string }
  | { ok: false; reason: AgentPaneRestartRefusal }

export abstract class OrcaRuntimeWithRestartAgentPaneInPlace extends OrcaRuntimeWithResumeAgentSessionInWorkspace {
  private readonly agentPaneRestartsByPaneKey = new Set<string>()
  protected abstract readonly sleepResumeRecords: WorktreeSleepResumeRecorder

  /** Restarts a pane's agent conversation in a new terminal in the same tab and leaf; the spawn
   *  applies whatever account is selected now. Refusals other than `stop_failed` and
   *  `create_failed` stop nothing. `stillCurrent` confirms, last before the stop, that the pane still
   *  runs `session` and should move. */
  async restartAgentPaneInPlace(
    ptyId: string,
    session: { agent: TuiAgent; providerSession: AgentProviderSessionMetadata },
    stillCurrent: () => boolean | Promise<boolean> = () => true
  ): Promise<AgentPaneRestartResult> {
    const pty = this.ptysById.get(ptyId)
    const recorded = this.paneOfPty(pty)
    const pane = parsePaneKey(recorded.paneKey ?? '')
    const tabId = recorded.tabId
    if (
      !pty?.connected ||
      pty.connectionId !== null ||
      isRemoteRuntimePtyId(ptyId) ||
      !pane ||
      !tabId
    ) {
      return { ok: false, reason: 'not_local' }
    }
    if (!this.terminalViewSubscribers.everyRemoteViewFollowsHostRespawn(ptyId)) {
      return { ok: false, reason: 'viewer_cannot_follow' }
    }
    const paneKey = `${pty.worktreeId}\0${tabId}\0${pane.leafId}`
    if (this.agentPaneRestartsByPaneKey.has(paneKey) || !this.ptyController?.stopAndWait) {
      return { ok: false, reason: 'busy' }
    }
    this.agentPaneRestartsByPaneKey.add(paneKey)
    let held: AgentSessionResumeClaim | null = null
    let dispatched = false
    try {
      // Resolved before the stop, so nothing after it can leave the pane without its agent.
      const resume = await this.resolveTerminalWorkspaceLaunchScope(`id:${pty.worktreeId}`)
        .then((workspace) =>
          this.resolveMobileSessionResumeCommand(workspace, {
            ...session,
            launchConfig: pty.launchConfig ?? undefined
          })
        )
        .catch(() => null)
      if (!resume) {
        return { ok: false, reason: 'no_resume_command' }
      }
      const ownPaneKey = makePaneKey(tabId, pane.leafId)
      // Held from before the live-pane check, so no other resume can start this conversation
      // while it runs or in the gap after the stop.
      const claim = this.agentSessionResumeClaims.claim(session, ownPaneKey)
      if (!claim) {
        return { ok: false, reason: 'busy' }
      }
      held = claim
      const refuse = (reason: AgentPaneRestartRefusal): AgentPaneRestartResult => {
        claim.settleFailure(false)
        return { ok: false, reason }
      }
      if (await this.isProviderSessionLiveInAnotherPane(session, ownPaneKey).catch(() => true)) {
        return refuse('busy')
      }
      const wasActive =
        this.mobileSessionTabsByWorktree
          .get(pty.worktreeId)
          ?.tabs.some(
            (tab) =>
              tab.type === 'terminal' &&
              tab.parentTabId === tabId &&
              tab.leafId === pane.leafId &&
              tab.isActive
          ) === true
      // Before stillCurrent (the last awaited check) and the stop, whose exit clears the hook rows:
      // a failed replacement still resumes from it.
      const resumeRecord = await this.sleepResumeRecords
        .capture(pty.worktreeId, new Set([ptyId]))
        .catch(() => null)
      if (
        !(await Promise.resolve()
          .then(stillCurrent)
          .catch(() => false))
      ) {
        return refuse('busy')
      }
      // A conversation started outside Orca holds no claim; it may have appeared during that await.
      if (await this.isProviderSessionLiveInAnotherPane(session, ownPaneKey).catch(() => true)) {
        return refuse('busy')
      }
      // The awaits above let the pane move, change process or gain a viewer: checked again with no
      // await before the stop.
      const current = this.ptysById.get(ptyId)
      if (
        !current?.connected ||
        (current.incarnationId ?? null) !== (pty.incarnationId ?? null) ||
        this.paneOfPty(current).paneKey !== recorded.paneKey
      ) {
        return refuse('not_local')
      }
      if (!this.terminalViewSubscribers.everyRemoteViewFollowsHostRespawn(ptyId)) {
        return refuse('viewer_cannot_follow')
      }
      let stopped = false
      // Left as a slept pane is: its next view starts it afresh and resumes the conversation.
      const failedStart = async (): Promise<AgentPaneRestartResult> => {
        // A closed tab or a successor terminal owns the pane now: its saved state stays theirs.
        const bound = this.storedPaneBinding({
          worktreeId: pty.worktreeId,
          tabId,
          leafId: pane.leafId
        })
        if (bound === null || (bound !== undefined && bound !== ptyId)) {
          return { ok: false, reason: 'create_failed' }
        }
        if (resumeRecord) {
          await this.sleepResumeRecords.persist(pty.worktreeId, resumeRecord, [ptyId])
        }
        this.forgetStoppedPaneTerminal(pty.worktreeId, tabId, pane.leafId, ptyId)
        return { ok: false, reason: 'create_failed' }
      }
      try {
        // 'replaced' keeps the pane's surface through the exit for the new terminal to take.
        const settleStop = this.intentionalPtyStops.mark(
          ptyId,
          'replaced',
          pty.incarnationId ?? null
        )
        try {
          stopped = await this.ptyController.stopAndWait(ptyId)
        } finally {
          settleStop(stopped)
        }
        if (!stopped) {
          return refuse('stop_failed')
        }
        // The saved binding still names the stopped terminal, which the create would try to reattach.
        const released = await retireReplacedPaneBinding(this.store, {
          ptyId,
          pane: { worktreeId: pty.worktreeId, tabId, leafId: pane.leafId, hostId: undefined }
        })
        if (!released) {
          // Another terminal or a close took the pane meanwhile: nothing is left to resume.
          return refuse('create_failed')
        }
        const created = await this.createRuntimeOwnedMobileSessionTerminal(
          pty.worktreeId,
          wasActive,
          undefined,
          {
            command: resume.command,
            env: resume.env,
            startupCommandDelivery: resume.startupCommandDelivery,
            launchConfig: resume.launchConfig,
            launchAgent: resume.launchAgent,
            launchRuntime: resume.launchRuntime,
            resumeProviderSession: resume.resumeProviderSession,
            spawnIntent: 'user-resume',
            // A desktop window that didn't hold the pane isn't shown or focused to the new terminal.
            presentation: 'background',
            identity: { tabId, leafId: pane.leafId },
            reopensPane: true,
            onPtySpawnDispatched: () => {
              dispatched = true
            },
            onPtyCreated: claim.bind
          }
        )
        if (created.tab.status === 'ready' && created.tab.ptyId) {
          return { ok: true, ptyId: created.tab.ptyId }
        }
        // A dispatched spawn may still run an agent: its share stays held, as resume's does.
        claim.settleFailure(dispatched)
        return await failedStart()
      } catch (error) {
        // Admission refusing the pane (its tab closed meanwhile) proves no spawn ran.
        const refusedBeforeSpawn =
          error instanceof Error &&
          (error.message === 'tab_not_found' || error.message === 'terminal_split_source_not_found')
        claim.settleFailure(dispatched && !refusedBeforeSpawn, error)
        console.warn('[runtime] could not restart an agent pane in place', { ptyId, error })
        return stopped ? await failedStart() : { ok: false, reason: 'stop_failed' }
      }
    } catch (error) {
      // A throw outside the stop and create must not leave the conversation held with no terminal.
      held?.settleFailure(dispatched, error)
      console.warn('[runtime] could not restart an agent pane in place', { ptyId, error })
      return { ok: false, reason: 'create_failed' }
    } finally {
      this.agentPaneRestartsByPaneKey.delete(paneKey)
    }
  }

  /** The terminal service refuses to reattach a terminal it was told to kill, so the pane's row
   *  stops naming it, as the saved layout already does. */
  private forgetStoppedPaneTerminal(
    worktreeId: string,
    tabId: string,
    leafId: string,
    ptyId: string
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    let changed = false
    const tabs = snapshot?.tabs.map((tab) => {
      if (tab.type !== 'terminal' || tab.parentTabId !== tabId) {
        return tab
      }
      const own = tab.leafId === leafId && tab.ptyId === ptyId
      const layout = tab.parentLayout
      const inLayout = layout?.ptyIdsByLeafId?.[leafId] === ptyId
      if (!own && !inLayout) {
        return tab
      }
      changed = true
      const { [leafId]: _stopped, ...ptyIdsByLeafId } = layout?.ptyIdsByLeafId ?? {}
      return {
        ...tab,
        ...(own ? { ptyId: null, incarnationId: null } : {}),
        ...(layout && inLayout ? { parentLayout: { ...layout, ptyIdsByLeafId } } : {})
      }
    })
    if (snapshot && tabs && changed) {
      this.storeMobileSessionSnapshot(worktreeId, { ...snapshot, tabs })
      this.scheduleMobileSessionTabsChanged(worktreeId)
    }
  }
}
