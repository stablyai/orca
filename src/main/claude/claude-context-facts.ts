import {
  contextTokensFromUsage,
  MAX_CONTEXT_MODEL_ID_CHARS,
  type AgentSessionContextReport,
  type AgentSessionContextUsage,
  type AgentSessionContextWindow
} from '../../shared/agent-session-context-usage'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  claudeContextResetKind,
  claudeContextWindowFromResult,
  claudeContextWindowHint,
  claudeTokenUsage,
  type ClaudeMainThreadModel
} from './claude-context-usage'
import type { ClaudeOpenTurn } from './claude-open-turn'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import type { ClaudeTurnEnd } from './claude-turn-lifecycle-item'
import { isRootClaudeFrame } from './claude-turn-opening'
import {
  writeAgentJournalTurnRow,
  type AgentJournalTurnRowTarget
} from '../native-chat/agent-session-timeline/agent-journal-turn-row-revision'

const CONVERSATION_FRAME_TYPES = new Set(['assistant', 'user', 'stream_event'])

/** Null targets the newest journal turn when no turn was open at request time. */
export type ClaudeContextReportTarget = AgentJournalItemIdentity | null

export type ClaudeContextReportPart = 'report' | 'window'

const STALE = Symbol('stale-window')

export class ClaudeContextFacts {
  private activity = 0
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
  private readonly requestListeners = new Set<(target: ClaudeContextReportTarget) => void>()

  constructor(
    private readonly turn: ClaudeOpenTurn,
    private readonly sink: StructuredAgentSessionEventSink
  ) {}

  get activityRevision(): number {
    return this.activity
  }

  markActivity(): void {
    this.activity += 1
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

  settle(message: Record<string, unknown>, end: ClaudeTurnEnd): void {
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
      this.turn.settle(end)
      if (facts) {
        this.write(facts)
      }
    } else {
      this.turn.settle(end, facts)
    }
    this.requestReport(settled)
  }

  /** Reports overtaken by activity retain only the window; full reports also replace usage. */
  recordReport(
    target: ClaudeContextReportTarget,
    report: AgentSessionContextReport,
    part: ClaudeContextReportPart
  ): void {
    const window = { tokens: report.windowTokens, capturedAt: report.capturedAt }
    this.servedModel = null
    this.windowReported = true
    // Before the first turn exists, retain the report's window for the first response.
    this.windowHint = report.windowTokens
    const contextUsage: AgentSessionContextUsage =
      part === 'report' ? { used: { kind: 'report', ...report }, window } : { window }
    writeAgentJournalTurnRow(
      this.sink,
      target === null ? { newest: true } : { identity: target },
      { contextUsage },
      { publish: true }
    )
  }

  subscribeReportRequests(listener: (target: ClaudeContextReportTarget) => void): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  dispose(): void {
    this.requestListeners.clear()
  }

  private write(
    contextUsage: AgentSessionContextUsage,
    windowIfNoneHeld?: AgentSessionContextWindow
  ): void {
    const identity = this.turn.identity
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
      listener(target)
    }
  }
}
