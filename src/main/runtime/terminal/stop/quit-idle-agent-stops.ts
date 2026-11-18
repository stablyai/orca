import { OrcaRuntimeWithWorktreeSleepResumeRecording } from './worktree-sleep-resume-recording'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import { completedAgentTurnAllowsStop } from '../../../../shared/agent-session/lifecycle/stopping/completed-agent-turn-stop'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'

export type QuitStopTarget = {
  ptyId: string
  incarnationId: string | null
  /** The PTY's last write at selection; a later one may have opened a turn. */
  inputAt: number | null
}

// Agents whose hooks hold the status working while a background shell, monitor or cron runs; others
// report done over a running job, and stopping them would kill it.
const AGENTS_REPORTING_BACKGROUND_WORK = new Set(['claude'])

// Checkpoints run one at a time in the daemon adapter, so more stops in flight only queue work.
const QUIT_STOP_CONCURRENCY = 4

/** Typing from the turn's start on may be a queued or unsent draft (with no turn start, any typing
 *  may be); any write after the turn ended, Orca's own deliveries included, may start the next turn. */
function inputMayOpenTurn(
  status: AgentStatusIpcPayload,
  typedAt: number | null,
  writtenAt: number | null
): boolean {
  return (
    (typedAt !== null && (status.turnStartedAt === undefined || typedAt >= status.turnStartedAt)) ||
    (writtenAt !== null && writtenAt >= status.stateStartedAt)
  )
}

/** The PTY this machine's saved layout binds to the pane; window graphs are gone by quit. */
function savedPanePtyId(session: WorkspaceSessionState, paneKey: string): string | undefined {
  const pane = parsePaneKey(paneKey)
  return pane
    ? session.terminalLayoutsByTabId?.[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
    : undefined
}

export abstract class OrcaRuntimeWithQuitIdleAgentStops extends OrcaRuntimeWithWorktreeSleepResumeRecording {
  protected abstract ptyShowsComposerDraft(ptyId: string): boolean

  /**
   * This machine's agents that finished their turn and whose conversation the saved profile
   * resumes; mid-turn agents and plain shells are never picked. Read before quit teardown
   * clears hook rows and remote viewers.
   */
  selectIdleAgentTerminalsForQuit(): QuitStopTarget[] {
    // Local panes (SSH ones included) live in this machine's partition; a paired server stops its own.
    const session = this.store?.getWorkspaceSession?.()
    if (!session) {
      return []
    }
    const rows = this.getAgentProviderSessionSnapshotFn?.() ?? []
    return rows.flatMap((row) => {
      // Placeholder and structured rows claim no finished turn; remote and WSL agents stay on their host.
      if (
        row.providerSessionOnly ||
        row.structuredHost ||
        row.connectionId !== null ||
        !AGENTS_REPORTING_BACKGROUND_WORK.has(row.agentType ?? '')
      ) {
        return []
      }
      const ptyId = savedPanePtyId(session, row.paneKey)
      const pty = ptyId ? this.ptysById.get(ptyId) : undefined
      if (
        !pty?.connected ||
        pty.connectionId !== null ||
        pty.isWsl === true ||
        (pty.isWsl === null && process.platform === 'win32')
      ) {
        return []
      }
      const savedRecord = session.sleepingAgentSessionsByPaneKey?.[row.paneKey]
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
      const inputAt = this.terminalRunFacts.readLastInputAt(pty.ptyId)
      if (
        !completedAgentTurnAllowsStop(status) ||
        attention.shownRemotely ||
        inputMayOpenTurn(status, attention.lastInputAt, inputAt) ||
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
      return [{ ptyId: pty.ptyId, incarnationId: pty.incarnationId, inputAt }]
    })
  }

  /** Stop the picked agents, keeping history, once the final profile save holds their records;
   *  the next launch finds each pane as after a reboot and resumes it. */
  async stopIdleAgentTerminalsForQuit(
    targets: readonly QuitStopTarget[],
    deadlineMs: number
  ): Promise<string[]> {
    const stopAndWait = this.ptyController?.stopAndWait?.bind(this.ptyController)
    if (!stopAndWait) {
      return []
    }
    const pending = [...targets]
    const stopped: string[] = []
    // Admit a few at a time and none past the deadline: each stop queues a final history checkpoint
    // that runs even after its caller gave up, ahead of the disconnect checkpoint for survivors.
    const admitUntilDeadline = async (): Promise<void> => {
      for (let next = pending.shift(); next && Date.now() < deadlineMs; next = pending.shift()) {
        if (await this.stopQuitTarget(stopAndWait, next, deadlineMs)) {
          stopped.push(next.ptyId)
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(QUIT_STOP_CONCURRENCY, pending.length) }, admitUntilDeadline)
    )
    return stopped
  }

  private async stopQuitTarget(
    stopAndWait: NonNullable<RuntimePtyController['stopAndWait']>,
    { ptyId, incarnationId, inputAt }: QuitStopTarget,
    deadlineMs: number
  ): Promise<boolean> {
    // A write since selection (a delivered turn, a paired client) may have started work.
    if (this.terminalRunFacts.readLastInputAt(ptyId) !== inputAt) {
      return false
    }
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
    return done
  }
}
