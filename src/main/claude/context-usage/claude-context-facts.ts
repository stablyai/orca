import {
  contextTokensFromUsage,
  MAX_CONTEXT_MODEL_ID_CHARS,
  type AgentSessionContextReport,
  type AgentSessionContextUsage,
  type AgentSessionContextWindow
} from '../../../shared/agent-session/agent-session-context-usage'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  claudeContextResetKind,
  claudeContextWindowFromResult,
  claudeContextWindowHint,
  claudeTokenUsage,
  type ClaudeMainThreadModel
} from './claude-context-usage'
import type { ClaudeOpenTurn, ClaudeStoppedTurnEnd } from '../structured/turns/claude-open-turn'
import { claudeRecord, claudeText } from '../structured/journal/claude-structured-item-translation'
import type { ClaudeTurnEnd } from '../structured/turns/claude-turn-lifecycle-item'
import { isRootClaudeFrame } from '../structured/turns/claude-turn-opening'
import {
  writeAgentJournalTurnRow,
  type AgentJournalTurnRowTarget
} from '../../native-chat/agent-session-timeline/agent-journal-turn-row-revision'

const CONVERSATION_FRAME_TYPES = new Set(['assistant', 'user', 'stream_event'])

/** Null targets the newest journal turn when no turn was open at request time. */
export type ClaudeContextReportTarget = AgentJournalItemIdentity | null

/** `askedAt` returns with the answer to `recordReport`. */
export type ClaudeContextReportListener = (
  target: ClaudeContextReportTarget,
  askedAt: number
) => void

const STALE = Symbol('stale-window')

export class ClaudeContextFacts {
  private activity = 0
  /** Advances on every newer used count, written or held back; a report asked for earlier must not replace it. */
  private usedCounts = 0
  private mainModel: ClaudeMainThreadModel = { initModel: null, responseModel: null }
  /** Null adopts the next response model; STALE blocks estimates until a fresh window arrives. */
  private servedModel: string | null | typeof STALE = null
  /** A report since the latest init or model change overrides result-based window inference. */
  private windowReported = false
  /** Reported or configured window fallback until a model change invalidates it. */
  private windowHint: number | null = null
  /** Check the journal before seeding a configured window hint. */
  private journalMayLackWindow = true
  private lastResponse: string | null = null
  private readonly requestListeners = new Set<ClaudeContextReportListener>()
  private readonly activityListeners = new Set<() => void>()

  constructor(
    private readonly turn: ClaudeOpenTurn,
    private readonly sink: StructuredAgentSessionEventSink
  ) {}

  get activityRevision(): number {
    return this.activity
  }

  markActivity(): void {
    for (const listener of this.activityListeners) {
      listener()
    }
    this.activity += 1
  }

  subscribeActivity(listener: () => void): () => void {
    this.activityListeners.add(listener)
    return () => this.activityListeners.delete(listener)
  }

  /** Observe before journaling. */
  observe(message: Record<string, unknown>, observedAt: number): void {
    if (CONVERSATION_FRAME_TYPES.has(String(message.type)) && isRootClaudeFrame(message)) {
      this.markActivity()
    }
    const initModel =
      message.type === 'system' && message.subtype === 'init' && isRootClaudeFrame(message)
        ? claudeText(message.model)
        : null
    if (initModel) {
      this.mainModel = { initModel, responseModel: null }
      this.windowReported = false
    }
    const reset = claudeContextResetKind(message)
    if (reset) {
      this.forget(observedAt, reset === 'compaction')
    }
  }

  modelMayHaveChanged(observedAt: number = Date.now()): void {
    this.servedModel = STALE
    this.windowReported = false
    this.windowHint = null
    this.forget(observedAt, true)
  }

  modelWritten(model: string): void {
    this.windowHint = claudeContextWindowHint(model)
  }

  /** Observe after journaling so usage, including tool-only responses, lands on the opened turn. */
  observeResponse(message: Record<string, unknown>, observedAt: number): void {
    if (message.type !== 'assistant' || !isRootClaudeFrame(message)) {
      return
    }
    const response = claudeRecord(message.message)
    // Synthetic responses have zero usage and placeholder models.
    const usage = claudeTokenUsage(response?.usage)
    if (!usage || contextTokensFromUsage(usage) === 0) {
      return
    }
    const named = claudeText(response?.model)
    const model = named && named.length <= MAX_CONTEXT_MODEL_ID_CHARS ? named : null
    if (model) {
      this.mainModel = { ...this.mainModel, responseModel: model }
    }
    const hint: AgentSessionContextWindow | null =
      this.windowHint === null ? null : { tokens: this.windowHint, capturedAt: observedAt }
    let window: AgentSessionContextWindow | undefined
    if (this.servedModel === STALE) {
      // After a model change, only a configured hint can serve estimates before the report.
      if (!hint) {
        this.usedCounts += 1
        return
      }
      window = hint
      this.servedModel = null
    } else if (model && this.servedModel !== null && model !== this.servedModel) {
      // Plan approval can switch models mid-turn without a new init.
      this.modelMayHaveChanged(observedAt)
      return
    }
    this.servedModel = model ?? this.servedModel
    const dedupe = JSON.stringify([this.turn.id, usage])
    if (dedupe === this.lastResponse) {
      return
    }
    this.lastResponse = dedupe
    const windowIfNoneHeld = !window && this.journalMayLackWindow ? hint : null
    if (window || windowIfNoneHeld) {
      this.journalMayLackWindow = false
    }
    this.write(
      { used: { kind: 'estimate', usage, capturedAt: observedAt }, ...(window ? { window } : {}) },
      windowIfNoneHeld ?? undefined
    )
  }

  settle(
    message: Record<string, unknown>,
    end: ClaudeTurnEnd,
    stopped?: ClaudeStoppedTurnEnd
  ): void {
    const tokens = this.windowReported
      ? null
      : claudeContextWindowFromResult(message, this.mainModel)
    const facts = tokens === null ? undefined : { window: { tokens, capturedAt: end.completedAt } }
    if (facts) {
      this.servedModel = null
      this.journalMayLackWindow = false
    }
    const settled = this.turn.identity
    if (settled === null) {
      this.turn.settle(end, undefined, stopped)
      if (facts) {
        this.write(facts)
      }
    } else {
      this.turn.settle(end, facts, stopped)
    }
    this.requestReport(settled)
  }

  /** A report asked for before a newer used count retains only the window; otherwise it also replaces usage. */
  recordReport(
    target: ClaudeContextReportTarget,
    report: AgentSessionContextReport,
    askedAt: number
  ): void {
    const window = { tokens: report.windowTokens, capturedAt: report.capturedAt }
    this.servedModel = null
    this.windowReported = true
    // Before the first turn exists, retain the report's window for the first response.
    this.windowHint = report.windowTokens
    this.write(
      askedAt === this.usedCounts ? { used: { kind: 'report', ...report }, window } : { window },
      undefined,
      target
    )
  }

  subscribeReportRequests(listener: ClaudeContextReportListener): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  dispose(): void {
    this.activityListeners.clear()
    this.requestListeners.clear()
  }

  private write(
    contextUsage: AgentSessionContextUsage,
    windowIfNoneHeld?: AgentSessionContextWindow,
    identity: ClaudeContextReportTarget = this.turn.identity
  ): void {
    if (contextUsage.used) {
      this.usedCounts += 1
    }
    const target: AgentJournalTurnRowTarget = identity ? { identity } : { newest: true }
    // No later frame may arrive to publish this fact.
    writeAgentJournalTurnRow(
      this.sink,
      target,
      { contextUsage, ...(windowIfNoneHeld ? { windowIfNoneHeld } : {}) },
      { publish: true }
    )
  }

  private forget(observedAt: number, requestReport: boolean): void {
    this.markActivity()
    this.lastResponse = null
    this.write({ used: { kind: 'unknown', capturedAt: observedAt } })
    if (requestReport) {
      this.requestReport(this.turn.identity)
    }
  }

  private requestReport(target: ClaudeContextReportTarget): void {
    for (const listener of this.requestListeners) {
      listener(target, this.usedCounts)
    }
  }
}
