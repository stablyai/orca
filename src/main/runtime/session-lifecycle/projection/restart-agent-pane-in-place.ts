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
  | 'stop_failed'
  /** Stopped, but no new terminal took the pane: its conversation waits for a manual resume. */
  | 'create_failed'

export type AgentPaneRestartResult =
  | { ok: true; ptyId: string }
  | { ok: false; reason: AgentPaneRestartRefusal }

export abstract class OrcaRuntimeWithRestartAgentPaneInPlace extends OrcaRuntimeWithResumeAgentSessionInWorkspace {
  private readonly agentPaneRestartsByPaneKey = new Set<string>()

  /** Restarts a pane's agent conversation in a new terminal in the same tab and leaf; the spawn
   *  applies whatever account is selected now. Every refusal but `create_failed` stops nothing. */
  async restartAgentPaneInPlace(
    ptyId: string,
    session: { agent: TuiAgent; providerSession: AgentProviderSessionMetadata }
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
      // A viewer may have joined during the awaits above; checked again just before the stop.
      if (!this.ptysById.get(ptyId)?.connected) {
        return { ok: false, reason: 'not_local' }
      }
      if (!this.terminalViewSubscribers.everyRemoteViewFollowsHostRespawn(ptyId)) {
        return { ok: false, reason: 'viewer_cannot_follow' }
      }
      // Held from before the stop, so no other resume can start this conversation in the gap.
      const claim = this.agentSessionResumeClaims.claim(session, makePaneKey(tabId, pane.leafId))
      if (!claim) {
        return { ok: false, reason: 'busy' }
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
          claim.settleFailure(false)
          return { ok: false, reason: stopped ? 'create_failed' : 'stop_failed' }
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
        claim.settleFailure(dispatched)
        return { ok: false, reason: 'create_failed' }
      } catch (error) {
        claim.settleFailure(dispatched, error)
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
