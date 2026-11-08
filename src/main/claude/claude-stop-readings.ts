import type { JournalTimelineItemResolution } from '../native-chat/agent-session-journal/writing/journal-timeline-resolution'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionOptions
} from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'

/** The turn a person's Stop may have decided, and when the provider ended it. */
export type ClaudeStopCheck = { turnId: string; endedAt: number }

export type ClaudeStopReadings = {
  ran: JournalTimelineItemResolution | null
  stopped: JournalTimelineItemResolution | null
  reservedBytes: number
}

/** Submit a row's two readings; the writer keeps the one a Stop at its position selects. */
export function writeClaudeStopReadings(
  sink: StructuredAgentSessionEventSink,
  check: ClaudeStopCheck,
  readings: ClaudeStopReadings,
  options: StructuredAgentSessionRevisionOptions,
  { publish, onDecided }: { publish: boolean; onDecided?: (stopped: boolean) => void }
): boolean {
  const revise = publish ? sink.tryReviseResolvedItemAndPublish : sink.tryReviseResolvedItem
  if (!revise) {
    return false
  }
  revise.call(
    sink,
    readings.reservedBytes,
    { kind: 'stop-decided', ...check, ran: readings.ran, stopped: readings.stopped },
    options,
    onDecided && ((outcome) => onDecided(outcome.stopped === true))
  )
  return true
}
