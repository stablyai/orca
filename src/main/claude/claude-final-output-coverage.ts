import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

/** A refused final snapshot makes this acquisition's leaf unsafe; the next open re-derives it. */
export function createClaudeFinalOutputCoverage(target: StructuredAgentSessionEventSink) {
  let admitted = true
  const record = (result: StructuredAgentSessionSinkAdmission) => {
    admitted &&= result.accepted
    return result
  }
  const append: NonNullable<StructuredAgentSessionEventSink['tryAppendItem']> = (
    identity,
    body,
    options
  ) => {
    const result = target.tryAppendItem?.(identity, body, options)
    if (result === undefined) {
      target.appendItem(identity, body, options)
    }
    const admission = result ?? { accepted: true }
    return options.lifecycle ? record(admission) : admission
  }
  const revise = target.tryReviseResolvedItem
  const reviseAndPublish = target.tryReviseResolvedItemAndPublish
  const sink: StructuredAgentSessionEventSink = {
    ...target,
    appendItem: (identity, body, options) => {
      if (options.lifecycle) {
        append(identity, body, options)
      } else {
        target.appendItem(identity, body, options)
      }
    },
    tryAppendItem: append,
    ...(revise
      ? {
          tryReviseResolvedItem: (...args: Parameters<typeof revise>) => {
            const admission = revise(...args)
            return args[2].lifecycle ? record(admission) : admission
          }
        }
      : {}),
    ...(reviseAndPublish
      ? {
          tryReviseResolvedItemAndPublish: (...args: Parameters<typeof reviseAndPublish>) => {
            const admission = reviseAndPublish(...args)
            return args[2].lifecycle ? record(admission) : admission
          }
        }
      : {})
  }
  return {
    sink,
    get admitted() {
      return admitted
    }
  }
}
