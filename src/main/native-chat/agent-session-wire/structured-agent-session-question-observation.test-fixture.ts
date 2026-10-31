import { createAgentSessionCurrentRequestsReader } from '../../../shared/agent-session-current-requests-reader'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import type { QueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'

export async function observeAsyncQuestions(
  current: Pick<QueuedMessageTestRig, 'host'>,
  id: string
) {
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  const host = current.host
  const reader = createAgentSessionCurrentRequestsReader({
    read: (request) => host.readCurrentRequests(request, 'agent-session.current-requests.v2'),
    complete: (marker, items, payload) => {
      state = reduceStructuredAgentSession(state, {
        type: 'requests-complete',
        marker,
        items,
        payload
      })
    },
    replaceMarker: (marker) => {
      state = reduceStructuredAgentSession(state, { type: 'requests-marker', marker })
    },
    error: (error) => {
      throw error
    }
  })
  const close = await host.subscribe({
    id,
    sessionId: SESSION,
    boundedFrames: true,
    readsCurrentRequests: true,
    requestContract: 'agent-session.current-requests.v2',
    emit: (event) => {
      state = reduceStructuredAgentSession(state, { type: 'event', event })
      if (event.type !== 'end' && event.currentRequests) {
        reader.observe(event.currentRequests)
      }
    }
  })
  return {
    state: () => state,
    close: () => {
      close()
      reader.invalidate()
    }
  }
}
