import { createAgentSessionCurrentRequestsReader } from '../../../src/shared/agent-session-current-requests-reader'
import type {
  AgentSessionCurrentRequestsPiece,
  AgentSessionCurrentRequestsRead
} from '../../../src/shared/agent-session-current-requests-wire'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { StructuredAgentSessionAction } from '../../../src/shared/structured-agent-session-reducer'
import { isFinalAgentSessionReadRefusal } from '../../../src/shared/structured-agent-session-read-refusal'
import { createReconnectScheduler } from '../../../src/shared/structured-agent-session-reconnect'
import { readAgentSessionErrorRefusal } from '../../../src/shared/agent-session-write-failure'
import { isSubscribeEvent } from './mobile-structured-transcript-subscription'

/** Refusals no reopen gets past while this chat stays open: the host lacks or denies the method, or
 *  the chat's history cannot be read. Reconnecting starts a new read either way. */
function isFinalStreamFailure(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 'method_not_found' || code === 'forbidden') {
    return true
  }
  const refusal = readAgentSessionErrorRefusal(error)
  return (
    refusal?.code === 'structured_agent_session_unsupported' ||
    isFinalAgentSessionReadRefusal(refusal)
  )
}

/** A failed piece gets one fresh subscription opening; another failure settles this owner. A stream
 *  the host ends or fails is reopened with the desktop read's backoff.
 *  Unlike the desktop, it also stops on method_not_found/forbidden/unsupported and resets backoff only past a reopen's opening frame. */
export function startMobileStructuredTranscriptRead(args: {
  sessionId: string
  open: (onFrame: (raw: unknown) => void) => () => void
  read: (request: AgentSessionCurrentRequestsRead) => Promise<AgentSessionCurrentRequestsPiece>
  apply: (action: StructuredAgentSessionAction) => void
  applyQueued: (event: AgentSessionSubscribeEvent) => void
  error: (error: unknown) => void
  isCurrent: () => boolean
}): () => void {
  let stopped = false
  let generation = 0
  let reopened = false
  let close = (): void => {}
  const current = () => !stopped && args.isCurrent()
  const reopenScheduler = createReconnectScheduler({
    shouldStop: () => !current(),
    reconnect: () => open()
  })
  const retire = (): void => {
    generation += 1
    reader.invalidate()
    const end = close
    close = () => {}
    end()
  }
  const reader = createAgentSessionCurrentRequestsReader({
    read: args.read,
    complete: (marker, items) => {
      if (current()) {
        args.apply({ type: 'requests-complete', marker, items })
      }
    },
    replaceMarker: (marker) => {
      if (current()) {
        args.apply({ type: 'requests-marker', marker })
      }
    },
    error: (error) => {
      if (!current()) {
        return
      }
      retire()
      args.error(error)
      if (!reopened) {
        reopened = true
        open()
      } else {
        stopped = true
      }
    }
  })
  function open(): void {
    const openedGeneration = ++generation
    let openingFrame = true
    close = args.open((raw) => {
      if (!current() || generation !== openedGeneration) {
        return
      }
      if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'error') {
        retire()
        args.error(raw)
        if (isFinalStreamFailure('error' in raw ? raw.error : undefined)) {
          stopped = true
        } else {
          reopenScheduler.schedule()
        }
        return
      }
      if (!isSubscribeEvent(raw)) {
        return
      }
      if (raw.type === 'snapshot' || raw.type === 'reset') {
        reader.invalidate()
      }
      args.apply({ type: 'event', event: raw, opensSubscription: openingFrame })
      args.applyQueued(raw)
      if (raw.type === 'end') {
        retire()
        reopenScheduler.schedule()
      } else {
        // Not on the opening frame: a host that answers a reopen and then ends it must still back off.
        if (!openingFrame) {
          reopenScheduler.reset()
        }
        openingFrame = false
        if (raw.currentRequests?.sessionId === args.sessionId) {
          reader.observe(raw.currentRequests)
        }
      }
    })
  }
  open()
  return () => {
    stopped = true
    reopenScheduler.dispose()
    retire()
  }
}
