import type { AgentPaneChange } from '../../../../agent-hooks/observations/agent-transition-detector'
import { agentVerdictDisplayMark } from '../../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  hookRowAgentPhase,
  hookRowTransition
} from '../../../../../shared/agent-status/lifecycle/agent-transitions'
import type { RuntimeTerminalRead } from '../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import {
  TerminalAgentTurnNews,
  type TerminalAgentTurnNewsItem
} from '../../../push/notifications/terminal-agent-turn-news'
import { readCoordinatorMailCount } from '../../db/messages/dispatch-read-mail'
import { redactWorkerTerminalView } from '../../terminal-authority/views/worker-terminal-redaction'
import {
  failedLeadTurnFence,
  stopReportId,
  workerTurnStopDispatchId,
  type WorkerTurnStopDispatch,
  type WorkerTurnStopReportDeps
} from './worker-turn-stop-report'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { observeWorker, type WorkerRest } from './worker-presence-report'
import { firstWithin } from '../approvals/first-within'
import { showsClaudeDialog } from '../../../terminal/wait/claude-open-dialog-hold'
import type { WorkerApprovalPayload } from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import {
  agentBackgroundWait,
  agentLeadTurnFailedUnderChildWork
} from '../../../../../shared/agent-status/lifecycle/agent-background-wait'
import { WorkerBackgroundWaits } from './worker-background-waits'
import { hasRelayedWorkerReport } from '../../db/worker-presence/worker-presence-store'
import { resolveTerminalWorkerDispatch } from './terminal-worker-dispatch'
import { terminalRequestError } from './terminal-request-error'
export { resolveTerminalWorkerDispatch }

export type TerminalWorkerTurnStopsDeps = WorkerTurnStopReportDeps & {
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
  getHandle: (paneKey: string) => string | null
  getProcessIncarnation: (handle: string) => string | null
  readScreen: (handle: string) => Promise<RuntimeTerminalRead>
  /** The pane's open approval Orca can answer. */
  takeOpenApproval: (paneKey: string, dispatchId: string) => Promise<WorkerApprovalPayload | null>
  /** Called only once the approval's escalation went out. */
  markApprovalReported: (approvalId: string) => void
}

/** Report a terminal worker whose turn ended (or stopped at a prompt) while its Dispatch is open. */
type PreparedStop = TerminalAgentTurnNewsItem & { dispatchId: string | null; mailTaken?: number }

export class TerminalWorkerTurnStops {
  private readonly news: TerminalAgentTurnNews<PreparedStop>
  /** Turns held open only by their own background tasks, terminal or chat: rests of their own. */
  readonly backgroundWaits: WorkerBackgroundWaits

  constructor(private readonly deps: TerminalWorkerTurnStopsDeps) {
    this.backgroundWaits = new WorkerBackgroundWaits(deps)
    this.news = new TerminalAgentTurnNews({
      readHookRow: deps.readHookRow,
      // The Dispatch the stop belongs to is the one active when the stop was seen.
      prepare: (news) => {
        const resolved = this.resolve(news.paneKey)
        const dispatchId = resolved && workerTurnStopDispatchId(resolved.target)
        return {
          ...news,
          dispatchId,
          ...(resolved && dispatchId
            ? { mailTaken: readCoordinatorMailCount(resolved.db, dispatchId) }
            : {})
        }
      },
      deliver: (stop, row) => void this.report(stop, row),
      setTimer: deps.setTimer,
      // A lead waiting on its own children is not stopped; their all-clear is.
      allClearOnly: true
    })
  }

  observe(change: AgentPaneChange): void {
    this.news.observe(change)
    this.backgroundWaits.observe(change)
    // A turn starting is the worker's own news: once per edge, not per hook post.
    const working =
      change.kind === 'moved'
        ? change.to === 'working'
        : change.kind === 'seeded' && change.phase === 'working'
    const row = working ? this.deps.readHookRow(change.paneKey) : null
    // A turn held open only by its background tasks, or failed under them, is a rest those waits record.
    if (
      working &&
      !row?.structuredHost &&
      !(row && (agentBackgroundWait(row) || agentLeadTurnFailedUnderChildWork(row)))
    ) {
      const resolved = this.resolve(change.paneKey)
      if (resolved) {
        observeWorker(resolved.db, resolved.target, { presence: 'working' }, this.deps)
      }
    }
  }

  /** A pane restored at rest: its stop came while Orca was down, so no live edge announced it. A turn
   *  its user stopped, or a session boundary, is no news here either, as it is live. */
  async reportRestingPane(paneKey: string): Promise<void> {
    const row = this.deps.readHookRow(paneKey)
    if (this.backgroundWaits.reportFailedLeadTurn(paneKey, row)) {
      return
    }
    const news = row && hookRowTransition('working', hookRowAgentPhase(row), row) !== null
    const resolved = news ? this.resolve(paneKey) : null
    if (!row || !resolved) {
      return
    }
    const dispatchId = workerTurnStopDispatchId(resolved.target)
    await this.report(
      {
        paneKey,
        worktreeId: row.worktreeId ?? '',
        row,
        dispatchId,
        mailTaken: readCoordinatorMailCount(resolved.db, dispatchId)
      },
      row
    )
  }

  /** `latest` is the stop's row at delivery, holding a reply read from the transcript since. */
  private async report(stop: PreparedStop, latest: AgentStatusIpcPayload): Promise<void> {
    const stopped = this.stillStopped(stop)
    if (!stopped) {
      return
    }
    // A relaunched agent in the same pane is a new process, whatever its hook clock says.
    const incarnation = this.deps.getProcessIncarnation(stopped.handle) ?? stopped.handle
    const reason: WorkerRest['reason'] =
      hookRowAgentPhase(stop.row) === 'needs-you'
        ? 'needs-input'
        : agentVerdictDisplayMark(stop.row) === 'failed'
          ? 'errored'
          : 'finished'
    // A failure the agent typed is worded as chat workers word it; the screen adds nothing.
    const requestError = reason === 'errored' ? terminalRequestError(stop.row) : null
    // A clean finish has the agent's own last words; an error or prompt is on the screen.
    const lastOutput = requestError
      ? undefined
      : (reason === 'finished' && (latest.lastAssistantMessage || stop.row.lastAssistantMessage)) ||
        (await this.readStopScreen(
          stopped.handle,
          reason === 'needs-input' && stop.row.agentType === 'claude'
        ))
    const before = this.stillStopped(stop)
    // One report per approval; the screen shows Claude's own reason for asking.
    const approval =
      reason === 'needs-input' && before?.target.kind === 'local'
        ? await this.deps.takeOpenApproval(stop.paneKey, before.target.dispatch.id)
        : null
    // Both reads awaited: the worker may have resumed, reported, or been handed a new Dispatch since.
    const resolved = this.stillStopped(stop)
    if (
      !resolved ||
      (this.deps.getProcessIncarnation(resolved.handle) ?? resolved.handle) !== incarnation
    ) {
      return
    }
    // A failed turn already reported while its children ran is the same failure once they settle.
    const reportedFence = reportedFailedLeadFence(resolved.db, resolved.target, stop.row, reason)
    const sent = observeWorker(
      resolved.db,
      resolved.target,
      {
        presence: 'at-rest',
        // An approval seen on a prompt already reported is news of its own.
        fence:
          reportedFence ??
          `${incarnation}:${stop.row.stateStartedAt}${approval ? `:approval:${approval.approvalId}` : ''}`,
        legacyStopKey: `${stop.paneKey}:${stop.row.stateStartedAt}`,
        rest: {
          from: resolved.handle,
          turnStartedAt: stop.row.turnStartedAt,
          reason,
          mailTaken: stop.mailTaken,
          lastOutput,
          ...(requestError ? { requestError } : {}),
          ...(approval ? { approval } : {})
        }
      },
      this.deps
    )
    if (approval && sent) {
      this.deps.markApprovalReported(approval.approvalId)
    }
  }

  /** A prompt's dialog can paint after its hook posts, as a background subagent's did. */
  private async readStopScreen(handle: string, awaitDialog: boolean): Promise<string | undefined> {
    const read = () =>
      this.deps.readScreen(handle).then((view) => redactWorkerTerminalView(view).tail)
    const dialog = awaitDialog
      ? await firstWithin(this.deps.setTimer, () =>
          read().then((tail) => (showsClaudeDialog(tail) ? tail : null))
        )
      : null
    return (dialog ?? (await read().catch(() => undefined)))?.join('\n')
  }

  private stillStopped(stop: PreparedStop) {
    const resolved = this.atRest(stop.paneKey, stop.row) ? this.resolve(stop.paneKey) : null
    return resolved && workerTurnStopDispatchId(resolved.target) === stop.dispatchId
      ? resolved
      : null
  }

  /** Still on this stop: a resumed turn, or a lead whose children still work, has not stopped. */
  private atRest(paneKey: string, row: AgentStatusIpcPayload): boolean {
    const current = this.deps.readHookRow(paneKey)
    return (
      current !== null &&
      current.state !== 'working' &&
      current.stateStartedAt === row.stateStartedAt
    )
  }

  private resolve(paneKey: string) {
    return resolveTerminalWorkerDispatch(this.deps, paneKey)
  }
}

/** The fence of this errored turn's failed-lead report, when one already reached the coordinator. */
function reportedFailedLeadFence(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  row: AgentStatusIpcPayload,
  reason: WorkerRest['reason']
): string | null {
  if (reason !== 'errored' || !row.mainAgent) {
    return null
  }
  const fence = failedLeadTurnFence(row.mainAgent.stateStartedAt)
  const dispatchId = workerTurnStopDispatchId(target)
  const id = stopReportId(dispatchId, fence)
  const reported =
    target.kind === 'local'
      ? db.getMessageById(id) !== undefined
      : hasRelayedWorkerReport(db, dispatchId, id)
  return reported ? fence : null
}
