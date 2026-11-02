import { createAgentSessionCurrentRequestsReader } from '../../../src/shared/agent-session-current-requests-reader'
import type {
  AgentSessionCurrentRequestsPiece,
  AgentSessionCurrentRequestsRead
} from '../../../src/shared/agent-session-current-requests-wire'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { StructuredAgentSessionAction } from '../../../src/shared/structured-agent-session-reducer'
import { isSubscribeEvent } from './mobile-structured-transcript-subscription'

/** A failed piece gets one fresh subscription opening; another failure settles this owner. */
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
        stopped = true
        args.error(raw)
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
        reader.invalidate()
      } else {
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
    retire()
  }
}
