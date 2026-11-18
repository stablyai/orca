import { OrcaRuntimeWithResumeAgentSessionInWorkspace } from './resume-agent-session-in-workspace'
import { retireReplacedPaneBinding } from '../../../ipc/pty/pane/pane-owner-replacement'
import { makePaneKey, parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'

export type AgentPaneRestartRefusal =
  /** Not a live terminal of this host's own (an SSH relay or another server's pane). */
  | 'not_local'
  /** A client viewing the pane would be left on a dead pane by an older Orca. */
  | 'viewer_cannot_follow'
  | 'no_resume_command'
  | 'busy'
  /** The stop was sent but its exit unconfirmed: the terminal may still end, with no replacement. */
  | 'stop_failed'
  /** Stopped, but no new terminal took the pane: its conversation waits for a manual resume. */
  | 'create_failed'

export type AgentPaneRestartResult =
  | { ok: true; ptyId: string }
  | { ok: false; reason: AgentPaneRestartRefusal }

export abstract class OrcaRuntimeWithRestartAgentPaneInPlace extends OrcaRuntimeWithResumeAgentSessionInWorkspace {
  private readonly agentPaneRestartsByPaneKey = new Set<string>()

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
      let dispatched = false
      try {
        // 'replaced' keeps the pane's surface through the exit for the new terminal to take.
        const settleStop = this.intentionalPtyStops.mark(
          ptyId,
          'replaced',
          pty.incarnationId ?? null
        )
        let stopped = false
        try {
          stopped = await this.ptyController.stopAndWait(ptyId)
        } finally {
          settleStop(stopped)
        }
        // The saved binding still names the stopped terminal, which the create would try to reattach.
        const released =
          stopped &&
          (await retireReplacedPaneBinding(this.store, {
            ptyId,
            pane: { worktreeId: pty.worktreeId, tabId, leafId: pane.leafId, hostId: undefined }
          }))
        if (!released) {
          return refuse(stopped ? 'create_failed' : 'stop_failed')
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
        return { ok: false, reason: 'create_failed' }
      } catch (error) {
        // Admission refusing the pane (its tab closed meanwhile) proves no spawn ran.
        const refusedBeforeSpawn =
          error instanceof Error &&
          (error.message === 'tab_not_found' || error.message === 'terminal_split_source_not_found')
        claim.settleFailure(dispatched && !refusedBeforeSpawn, error)
        throw error
      }
    } catch (error) {
      console.warn('[runtime] could not restart an agent pane in place', { ptyId, error })
      return { ok: false, reason: 'create_failed' }
    } finally {
      this.agentPaneRestartsByPaneKey.delete(paneKey)
    }
  }
}
