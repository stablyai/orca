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
import type { OrchestrationDb } from '../../db/orchestration-db'
import { readCoordinatorMailCount } from '../../db/messages/dispatch-read-mail'
import { redactWorkerTerminalView } from '../../terminal-authority/views/worker-terminal-redaction'
import {
  workerTurnStopDispatchId,
  type WorkerRequestError,
  type WorkerTurnStopDispatch,
  type WorkerTurnStopReportDeps
} from './worker-turn-stop-report'
import { observeWorker, type WorkerRest } from './worker-presence-report'
import { firstWithin } from '../approvals/first-within'
import { showsClaudeDialog } from '../../../terminal/wait/claude-open-dialog-hold'
import type { WorkerApprovalPayload } from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import { claudeStopFailureFact } from '../../../../claude/structured/journal/claude-usage-limits'
import { failureRequestError } from './chat-worker-error-words'
import { redactFailure } from './worker-turn-stop-wording'

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

  constructor(private readonly deps: TerminalWorkerTurnStopsDeps) {
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
    // A turn starting is the worker's own news: once per edge, not per hook post.
    const working =
      change.kind === 'moved'
        ? change.to === 'working'
        : change.kind === 'seeded' && change.phase === 'working'
    if (working && !this.deps.readHookRow(change.paneKey)?.structuredHost) {
      const resolved = this.resolve(change.paneKey)
      if (resolved) {
        observeWorker(resolved.db, resolved.target, { presence: 'working' }, this.deps)
      }
    }
  }

  /** A pane restored at rest: its stop came while Orca was down, so no live edge announced it. A turn
   *  its user stopped, or a session boundary, is no news here either, as it is live. */
  reportRestingPane(paneKey: string): Promise<void> {
    const row = this.deps.readHookRow(paneKey)
    const news = row && hookRowTransition('working', hookRowAgentPhase(row), row) !== null
    const resolved = news ? this.resolve(paneKey) : null
    if (!row || !resolved) {
      return Promise.resolve()
    }
    const dispatchId = workerTurnStopDispatchId(resolved.target)
    return this.report(
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
    const sent = observeWorker(
      resolved.db,
      resolved.target,
      {
        presence: 'at-rest',
        // An approval seen on a prompt already reported is news of its own.
        fence: `${incarnation}:${stop.row.stateStartedAt}${approval ? `:approval:${approval.approvalId}` : ''}`,
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

/** The typed failure a terminal agent's turn ended on; null when it named none Orca words. */
function terminalRequestError(row: AgentStatusIpcPayload): WorkerRequestError | null {
  // A time-only reset is read against when the turn stopped: a pane restored later keeps that day.
  const fact =
    row.agentType === 'claude'
      ? claudeStopFailureFact(row.mainAgent?.failure, row.mainAgent?.stateStartedAt ?? Date.now())
      : null
  if (!fact) {
    return null
  }
  const words = agentSessionFailureWords(fact, {
    agentName: 'Claude',
    provider: 'claude',
    surface: 'row'
  })
  const error = failureRequestError(words.text, fact)
  const text = redactFailure(error.text)
  const detail = error.detail && redactFailure(error.detail)
  return {
    text,
    ...(detail ? { detail } : {}),
    kind: fact.kind,
    heldByWaits: true,
    facts: {
      stopReason: 'errored',
      agent: 'claude',
      turnOutcome: 'failure',
      failureKind: fact.kind,
      error: text,
      ...(detail ? { detail } : {})
    }
  }
}

/** The Dispatch a pane's worker runs now: its active local one, or the current remote attachment. */
export function resolveTerminalWorkerDispatch(
  deps: Pick<TerminalWorkerTurnStopsDeps, 'getDb' | 'getHandle' | 'getProcessIncarnation'>,
  paneKey: string
): {
  db: OrchestrationDb
  handle: string
  target: WorkerTurnStopDispatch
} | null {
  const db = deps.getDb()
  const handle = db ? deps.getHandle(paneKey) : null
  if (!db || !handle) {
    return null
  }
  const dispatch = db.getActiveDispatchForTerminal(handle, paneKey)
  if (dispatch) {
    return { db, handle, target: { kind: 'local', dispatch } }
  }
  // A paired server holds its remote workers as attachments; their Dispatch lives at the Run home.
  const attachment = db.findActiveRemoteAttachmentForPane(paneKey)
  return attachment &&
    db.isRemoteAttachmentProcessCurrent({
      dispatchId: attachment.dispatch_id,
      paneKey,
      processIncarnation: deps.getProcessIncarnation(handle)
    })
    ? { db, handle, target: { kind: 'remote', attachment } }
    : null
}
