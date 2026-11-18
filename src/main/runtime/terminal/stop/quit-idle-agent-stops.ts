import { OrcaRuntimeWithWorktreeSleepResumeRecording } from './worktree-sleep-resume-recording'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import { completedAgentTurnAllowsStop } from '../../../../shared/agent-session/lifecycle/stopping/completed-agent-turn-stop'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'

type QuitStopTarget = { ptyId: string; incarnationId: string | null }

/** Input from the turn's start on may be a queued or unsent draft; with no turn start, any input may be. */
function inputMayHoldDraft(status: AgentStatusIpcPayload, inputAt: number | null): boolean {
  return inputAt !== null && (status.turnStartedAt === undefined || inputAt >= status.turnStartedAt)
}

export abstract class OrcaRuntimeWithQuitIdleAgentStops extends OrcaRuntimeWithWorktreeSleepResumeRecording {
  /**
   * Stop this machine's agents that finished their turn and whose conversation the saved profile
   * can resume; mid-turn agents and plain shells keep running. Call only after the final profile
   * save, so the next launch finds each stopped pane as after a reboot and resumes it.
   */
  async stopIdleAgentTerminalsForQuit(deadlineMs: number): Promise<string[]> {
    const stopAndWait = this.ptyController?.stopAndWait?.bind(this.ptyController)
    if (!stopAndWait) {
      return []
    }
    const stopped = await Promise.all(
      this.idleAgentQuitStopTargets().map(async ({ ptyId, incarnationId }) => {
        // Reversible: the exit must not retire the saved conversation the next launch resumes.
        const settleStop = this.intentionalPtyStops.mark(ptyId, 'reversible', incarnationId)
        let done = false
        try {
          done = await stopAndWait(ptyId, { keepHistory: true, deadlineMs })
        } catch (error) {
          console.warn('[quit] Idle agent stayed running:', ptyId, error)
        } finally {
          settleStop(done)
        }
        return done ? [ptyId] : []
      })
    )
    return stopped.flat()
  }

  private idleAgentQuitStopTargets(): QuitStopTarget[] {
    const rows = this.getAgentProviderSessionSnapshotFn?.() ?? []
    return rows.flatMap((row) => {
      // Placeholder and structured rows claim no finished turn; remote and WSL agents stay on their host.
      if (row.providerSessionOnly || row.structuredHost || row.connectionId !== null) {
        return []
      }
      const pty = this.getPtyRecordForPaneKey(row.paneKey)
      if (
        !pty?.connected ||
        pty.connectionId !== null ||
        pty.isWsl === true ||
        (pty.isWsl === null && process.platform === 'win32')
      ) {
        return []
      }
      const savedRecord = this.savedRecordForQuitStop(row.paneKey, pty.worktreeId)
      const identity = this.readPaneAgentIdentity(row.paneKey, savedRecord)
      // A shared process (tmux) outlives the pane, and an ended or suspended agent is not idle.
      if (
        !identity ||
        identity.ended ||
        identity.suspended ||
        identity.processTopology !== 'pane-owned'
      ) {
        return []
      }
      const { status } = identity
      const attention = this.getTerminalAttention(pty.ptyId)
      if (
        !completedAgentTurnAllowsStop(status) ||
        attention.shownRemotely ||
        inputMayHoldDraft(status, attention.lastInputAt) ||
        this.ptyShowsComposerDraft(pty.ptyId)
      ) {
        return []
      }
      // Never lose a conversation: stop only what the saved profile resumes as this same session.
      if (
        !savedRecord ||
        savedRecord.agent !== status.agentType ||
        !agentProviderSessionsEqual(
          savedRecord.agent,
          savedRecord.providerSession,
          status.providerSession
        )
      ) {
        return []
      }
      return [{ ptyId: pty.ptyId, incarnationId: pty.incarnationId }]
    })
  }

  private savedRecordForQuitStop(
    paneKey: string,
    worktreeId: string
  ): SleepingAgentSessionRecord | undefined {
    const tabId = parsePaneKey(paneKey)?.tabId
    const hostId = tabId ? this.getWorkspaceSessionHostIdsForTab(worktreeId, tabId)[0] : undefined
    // A paired server's panes are that server's to stop.
    if (!hostId || parseExecutionHostId(hostId)?.kind === 'runtime') {
      return undefined
    }
    return this.store?.getWorkspaceSession?.(hostId)?.sleepingAgentSessionsByPaneKey?.[paneKey]
  }
}
