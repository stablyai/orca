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
    const targets: QuitStopTarget[] = []
    const kept: Record<string, string> = {}
    for (const row of this.getAgentProviderSessionSnapshotFn?.() ?? []) {
      // Placeholder and structured rows claim no finished turn; other agents may hide a running job.
      if (
        row.providerSessionOnly ||
        row.structuredHost ||
        !AGENTS_REPORTING_BACKGROUND_WORK.has(row.agentType ?? '')
      ) {
        continue
      }
      const pick = this.quitStopTargetFor(row, session)
      if (typeof pick === 'string') {
        kept[row.paneKey] = pick
      } else {
        targets.push(pick)
      }
    }
    // One line per quit: why each finished-looking agent kept running.
    console.info('[quit] Idle agent stops', { picked: targets.length, kept })
    return targets
  }

  private quitStopTargetFor(
    row: AgentStatusIpcPayload,
    session: WorkspaceSessionState
  ): QuitStopTarget | string {
    // Remote and WSL agents stay on their host.
    if (row.connectionId !== null) {
      return 'remote'
    }
    const ptyId = savedPanePtyId(session, row.paneKey)
    const pty = ptyId ? this.ptysById.get(ptyId) : undefined
    if (!pty?.connected) {
      return 'no-live-pty'
    }
    if (
      pty.connectionId !== null ||
      pty.isWsl === true ||
      (pty.isWsl === null && process.platform === 'win32')
    ) {
      return 'remote'
    }
    const savedRecord = session.sleepingAgentSessionsByPaneKey?.[row.paneKey]
    const identity = this.readPaneAgentIdentity(row.paneKey, savedRecord)
    // A shared process (tmux) outlives the pane, and an ended or suspended agent is not idle.
    if (!identity || identity.ended || identity.suspended) {
      return 'not-running'
    }
    if (identity.processTopology !== 'pane-owned') {
      return 'shared-process'
    }
    const { status } = identity
    if (!completedAgentTurnAllowsStop(status)) {
      return 'mid-turn'
    }
    const attention = this.getTerminalAttention(pty.ptyId)
    if (attention.shownRemotely) {
      return 'shown-remotely'
    }
    const inputAt = this.terminalRunFacts.readLastInputAt(pty.ptyId)
    if (inputMayOpenTurn(status, attention.lastInputAt, inputAt)) {
      return 'input-since-turn'
    }
    if (this.ptyShowsComposerDraft(pty.ptyId)) {
      return 'draft'
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
      return 'no-saved-conversation'
    }
    return { ptyId: pty.ptyId, incarnationId: pty.incarnationId, inputAt }
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
      console.info('[quit] Idle agent written to since it was picked; kept running:', ptyId)
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
