import type { AgentPaneChange } from '../../agent-hooks/agent-transition-detector'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { hookRowAgentPhase } from '../../../shared/agent-transitions'
import type { RuntimeTerminalRead } from '../../../shared/runtime-types'
import { TerminalAgentTurnNews, type TerminalAgentTurnNewsItem } from '../terminal-agent-turn-news'
import type { OrchestrationDb } from './db'
import { redactWorkerTerminalView } from './worker-terminal-redaction'
import {
  reportWorkerTurnStop,
  workerTurnStopDispatchId,
  type WorkerTurnStopDispatch,
  type WorkerTurnStopReason,
  type WorkerTurnStopReportDeps
} from './worker-turn-stop-report'

export type TerminalWorkerTurnStopsDeps = WorkerTurnStopReportDeps & {
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
  getHandle: (paneKey: string) => string | null
  getProcessIncarnation: (handle: string) => string | null
  readScreen: (handle: string) => Promise<RuntimeTerminalRead>
}

/** Report a terminal worker whose turn ended (or stopped at a prompt) while its Dispatch is open. */
type PreparedStop = TerminalAgentTurnNewsItem & { dispatchId: string | null }

export class TerminalWorkerTurnStops {
  private readonly news: TerminalAgentTurnNews<PreparedStop>

  constructor(private readonly deps: TerminalWorkerTurnStopsDeps) {
    this.news = new TerminalAgentTurnNews({
      readHookRow: deps.readHookRow,
      // The Dispatch the stop belongs to is the one active when the stop was seen.
      prepare: (news) => {
        const resolved = this.resolve(news.paneKey)
        return { ...news, dispatchId: resolved && workerTurnStopDispatchId(resolved.target) }
      },
      deliver: (stop) => void this.report(stop),
      setTimer: deps.setTimer,
      // A lead waiting on its own children is not stopped; their all-clear is.
      allClearOnly: true
    })
  }

  observe(change: AgentPaneChange): void {
    this.news.observe(change)
  }

  private async report(stop: PreparedStop): Promise<void> {
    const stopped = this.stillStopped(stop)
    if (!stopped) {
      return
    }
    const reason: WorkerTurnStopReason =
      hookRowAgentPhase(stop.row) === 'needs-you'
        ? 'needs-input'
        : agentVerdictDisplayMark(stop.row) === 'failed'
          ? 'errored'
          : 'finished'
    // A clean finish has the agent's own last words; an error or prompt is on the screen.
    const lastOutput =
      (reason === 'finished' && stop.row.lastAssistantMessage) ||
      (await this.deps
        .readScreen(stopped.handle)
        .then((view) => redactWorkerTerminalView(view).tail.join('\n'))
        .catch(() => undefined))
    // The read awaited: the worker may have resumed, reported, or been handed a new Dispatch since.
    const resolved = this.stillStopped(stop)
    if (!resolved) {
      return
    }
    reportWorkerTurnStop(
      resolved.db,
      resolved.target,
      {
        from: resolved.handle,
        stopKey: `${stop.paneKey}:${stop.row.stateStartedAt}`,
        reason,
        lastOutput
      },
      this.deps
    )
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

  private resolve(paneKey: string): {
    db: OrchestrationDb
    handle: string
    target: WorkerTurnStopDispatch
  } | null {
    const db = this.deps.getDb()
    const handle = db ? this.deps.getHandle(paneKey) : null
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
        processIncarnation: this.deps.getProcessIncarnation(handle)
      })
      ? { db, handle, target: { kind: 'remote', attachment } }
      : null
  }
}
