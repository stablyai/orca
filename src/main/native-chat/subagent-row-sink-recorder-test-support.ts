import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from './agent-session-wire/structured-agent-session-event-sink'

export type RecordedSubagentRowWrite =
  | {
      op: 'append'
      identity: AgentJournalItemIdentity
      body: AgentJournalItemBody
      turnScope: AgentJournalTurnScope | undefined
      accepted: boolean
    }
  | { op: 'tombstone'; identity: AgentJournalItemIdentity; accepted: boolean }
  | { op: 'publish'; accepted: boolean }

const ACCEPTED: StructuredAgentSessionSinkAdmission = { accepted: true }
const REFUSED: StructuredAgentSessionSinkAdmission = { accepted: false, reason: 'backpressure' }

/** A sink that records every row write in order, with refusals the test schedules. */
export function recordingSubagentRowSink(): {
  sink: StructuredAgentSessionEventSink
  log: RecordedSubagentRowWrite[]
  refuseNextAppend: () => void
  refuseNextPublish: () => void
} {
  const log: RecordedSubagentRowWrite[] = []
  let refuseAppend = false
  let refusePublish = false
  const admit = (refuse: boolean): StructuredAgentSessionSinkAdmission =>
    refuse ? REFUSED : ACCEPTED
  const sink: StructuredAgentSessionEventSink = {
    appendItem: () => {
      throw new Error('rows must use tryAppendItem')
    },
    appendTombstone: () => {
      throw new Error('rows must use tryAppendTombstone')
    },
    publish: () => {
      throw new Error('rows must use tryPublish')
    },
    tryAppendItem: (identity, body, options) => {
      const admission = admit(refuseAppend)
      refuseAppend = false
      log.push({
        op: 'append',
        identity,
        body: structuredClone(body),
        turnScope: options.turnScope,
        accepted: admission.accepted
      })
      return admission
    },
    tryAppendTombstone: (identity) => {
      const admission = admit(refuseAppend)
      refuseAppend = false
      log.push({ op: 'tombstone', identity, accepted: admission.accepted })
      return admission
    },
    tryPublish: () => {
      const admission = admit(refusePublish)
      refusePublish = false
      log.push({ op: 'publish', accepted: admission.accepted })
      return admission
    }
  }
  return {
    sink,
    log,
    refuseNextAppend: () => {
      refuseAppend = true
    },
    refuseNextPublish: () => {
      refusePublish = true
    }
  }
}
