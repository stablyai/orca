import type {
  AgentJournalRowAttribution,
  AgentJournalStatusItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { estimateStructuredAgentSessionItemBytes } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'

/** A frame row to write; a terminal error row also says when its frame was received and hears
 *  whether a person's Stop dropped it. */
export type CodexFrameRow = {
  body: AgentJournalStatusItem
  observedAt?: number
  onDecided?: (stopped: boolean) => void
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

/** Writes a Codex frame's row. A terminal error row is the Stop's to drop when a person's Stop of
 *  its journal turn caused it, judged at the frame's receipt time, the time its turn's end uses. */
export function writeCodexFrameRow(
  sink: StructuredAgentSessionEventSink,
  attribution: AgentJournalRowAttribution,
  { body, observedAt, onDecided }: CodexFrameRow,
  place: CodexFrameRowPlace
): CodexJournalTranslationAdmission {
  const terminalTurnId = codexTerminalTurnId(body, place.frameTurnId)
  const identity = {
    provider: 'orca' as const,
    clientMessageId: terminalTurnId
      ? `terminal-failure:codex:${JSON.stringify([place.threadId, terminalTurnId])}`
      : `provider-frame:codex:${place.fallbackKey}`
  }
  if (terminalTurnId && sink.tryReviseResolvedItem) {
    return sink.tryReviseResolvedItem(
      estimateStructuredAgentSessionItemBytes(identity, body),
      {
        kind: 'stop-decided',
        failure: true,
        turnId: place.stopTurnId?.(terminalTurnId) ?? terminalTurnId,
        endedAt: observedAt ?? place.receivedAt,
        ran: { kind: 'literal', identity, body },
        stopped: null
      },
      attribution,
      (outcome) => onDecided?.(outcome.stopped === true)
    )
  }
  const admission = sink.tryAppendItem
    ? sink.tryAppendItem(identity, body, attribution)
    : (sink.appendItem(identity, body, attribution), CODEX_JOURNAL_ADMITTED)
  if (admission.accepted) {
    onDecided?.(false)
  }
  return admission
}
