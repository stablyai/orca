import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalItemBody,
  AgentJournalRowAttribution,
  AgentJournalStatusItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { estimateStructuredAgentSessionItemBytes } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'

/** A frame row to write. A terminal error row also says when its frame was received; `ifAbsent`:
 *  it repeats an error an earlier row of its turn reported, so it is written only where that row
 *  is missing (a person's Stop dropped it). */
export type CodexFrameRow = {
  body: AgentJournalStatusItem
  observedAt?: number
  ifAbsent?: true
}

export type CodexFrameRowPlace = {
  threadId: string
  frameTurnId: string | null
  /** Names an ordinary frame's row. */
  fallbackKey: string
  /** The journal turn a provider turn belongs to: a command's own turn when one carries it. */
  stopTurnId?: (providerTurnId: string) => string
  receivedAt: number
}

/** The person's Stop a failure row is checked against: its journal turn, and when it failed. */
export type CodexFailureStop = { turnId: string; endedAt: number }

export function defaultCodexFrameSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function publishCodexFrames(
  sink: StructuredAgentSessionEventSink
): CodexJournalTranslationAdmission {
  return sink.tryPublish ? sink.tryPublish() : (sink.publish(), CODEX_JOURNAL_ADMITTED)
}

/** The turn a terminal error row reports: a failure that is not a retry notice, in a turn. */
export function codexTerminalTurnId(
  body: AgentJournalStatusItem,
  frameTurnId: string | null
): string | null {
  return body.failure && body.failure.kind !== 'providerRetrying' ? frameTurnId : null
}

function appendRow(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  options: AgentJournalRowAttribution
): CodexJournalTranslationAdmission {
  return sink.tryAppendItem
    ? sink.tryAppendItem(identity, body, options)
    : (sink.appendItem(identity, body, options), CODEX_JOURNAL_ADMITTED)
}

/** A row reporting a turn's failure, decided once, by the writer at its position: dropped when a
 *  person's Stop of that turn caused the failure (personStopDecidesFailure), and with `ifAbsent`
 *  also where a row with its identity already shows. Everything it needs is fixed now. */
export function writeCodexFailureRow(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  options: AgentJournalRowAttribution,
  stop: CodexFailureStop,
  ifAbsent?: true
): CodexJournalTranslationAdmission {
  if (!sink.tryReviseResolvedItem) {
    // A sink that can't decide at its writer keeps the earlier row, as before.
    return ifAbsent ? CODEX_JOURNAL_ADMITTED : appendRow(sink, identity, body, options)
  }
  const ran = ifAbsent
    ? { kind: 'literal-if-absent' as const, identity, body }
    : { kind: 'literal' as const, identity, body }
  return sink.tryReviseResolvedItem(
    estimateStructuredAgentSessionItemBytes(identity, body),
    { kind: 'stop-decided', failure: true, ...stop, ran, stopped: null },
    options
  )
}

/** Writes a Codex frame's row; a terminal error row is a failure row of its journal turn, judged at
 *  the frame's receipt time, the time its turn's end uses. */
export function writeCodexFrameRow(
  sink: StructuredAgentSessionEventSink,
  attribution: AgentJournalRowAttribution,
  { body, observedAt, ifAbsent }: CodexFrameRow,
  place: CodexFrameRowPlace
): CodexJournalTranslationAdmission {
  const terminalTurnId = codexTerminalTurnId(body, place.frameTurnId)
  const identity = {
    provider: 'orca' as const,
    clientMessageId: terminalTurnId
      ? `terminal-failure:codex:${JSON.stringify([place.threadId, terminalTurnId])}`
      : `provider-frame:codex:${place.fallbackKey}`
  }
  if (!terminalTurnId) {
    return appendRow(sink, identity, body, attribution)
  }
  const stop = {
    turnId: place.stopTurnId?.(terminalTurnId) ?? terminalTurnId,
    endedAt: observedAt ?? place.receivedAt
  }
  return writeCodexFailureRow(sink, identity, body, attribution, stop, ifAbsent)
}
