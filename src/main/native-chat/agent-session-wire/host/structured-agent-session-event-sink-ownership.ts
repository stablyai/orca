import {
  createDeferredStructuredAgentSessionEventSink,
  type DeferredStructuredAgentSessionEventSink
} from '../journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export function createHostedEventSink(
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>,
  adopted: ReadonlyMap<string, DeferredStructuredAgentSessionEventSink>,
  deps: Parameters<typeof createDeferredStructuredAgentSessionEventSink>[0]
): DeferredStructuredAgentSessionEventSink {
  const { sessionId } = deps
  const current = () => adopted.get(sessionId) === sink
  const sink = createDeferredStructuredAgentSessionEventSink({
    ...deps,
    onFailed: (error) => {
      // Attempt sinks cannot force down the session's adopted provider.
      if (current()) {
        deps.onFailed?.(error)
      }
    }
  })
  const owner = () => {
    const session = current() ? sessions.get(sessionId) : undefined
    return session?.child?.exitObservation === sink.exitObservation ? session : undefined
  }
  sink.sink.recordProviderReceipt = (receipt) => {
    const session = owner()
    if (session?.child) {
      session.providerReceipts?.stamp(sessionId, session.child, receipt)
    }
  }
  sink.sink.withdrawProviderReceipt = (handover) => {
    const session = owner()
    if (session?.child) {
      session.providerReceipts?.withdraw(sessionId, session.child, handover)
    }
  }
  const { close } = sink
  sink.close = () => {
    owner()?.providerReceipts?.retire(sessionId)
    close()
  }
  return sink
}
