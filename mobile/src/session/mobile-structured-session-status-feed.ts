// The connected host's status stream, which every structured chat on that host reads the host's
// "Stopping…" from. One per client, opened by the first chat that reads it and kept for the
// client's life: a phone has no way to end just this stream, so one per chat would leave a host
// subscriber behind each. The client replays it after a reconnect, and the host's fresh snapshot
// then replaces what contact loss revoked.

import {
  AgentSessionAssociationObservation,
  foldAgentSessionStatusEvent,
  revokeAgentSessionStatusLive,
  type AgentSessionStatusSnapshot
} from '../../../src/shared/agent-session-status-snapshot-fold'
import type { AgentSessionStatusEvent } from '../../../src/shared/agent-session-wire'
import {
  foldAgentSessionConversationNames,
  type AgentSessionConversationNames
} from '../../../src/shared/agent-session-conversation-names'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import type { RpcClient } from '../transport/rpc-client'

export type MobileStructuredSessionStatusFeed = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => AgentSessionStatusSnapshot
  getNamingSnapshot: () => AgentSessionConversationNames
  getAssociationRevision: () => number
}

const feeds = new WeakMap<RpcClient, MobileStructuredSessionStatusFeed>()

function isStatusEvent(value: unknown): value is AgentSessionStatusEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false
  }
  switch (value.type) {
    case 'snapshot':
      return 'sessions' in value && Array.isArray(value.sessions)
    case 'status':
      return 'session' in value && typeof value.session === 'object' && value.session !== null
    case 'end':
      return true
    default:
      return false
  }
}

/** The stream's refusal, as the client hands a failed opener to its listener. */
function streamRefusal(value: unknown): { code?: string; message?: string } | null {
  if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'error') {
    return null
  }
  const error = 'error' in value && typeof value.error === 'object' ? value.error : null
  const code = error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  const message =
    'message' in value && typeof value.message === 'string' ? value.message : undefined
  return { ...(code !== undefined ? { code } : {}), ...(message !== undefined ? { message } : {}) }
}

function createFeed(client: RpcClient): MobileStructuredSessionStatusFeed {
  let snapshot: AgentSessionStatusSnapshot = new Map()
  let names: AgentSessionConversationNames = new Map()
  const associations = new AgentSessionAssociationObservation()
  // `unavailable`: the host refused the method to phones; asked again only on a new connection.
  let stream: 'closed' | 'open' | 'unavailable' = 'closed'
  // Released once the host ends the stream, so the client never replays it on a later session.
  let releaseStream = (): void => {}
  const release = (): void => {
    const pending = releaseStream
    releaseStream = () => {}
    pending()
  }
  const listeners = new Set<() => void>()
  const setSnapshot = (
    next: AgentSessionStatusSnapshot,
    nextNames = names,
    associationChanged = false
  ): void => {
    if (!associationChanged && next === snapshot && nextNames === names) {
      return
    }
    snapshot = next
    names = nextNames
    for (const listener of listeners) {
      listener()
    }
  }
  const revokeLive = (): void => setSnapshot(revokeAgentSessionStatusLive(snapshot))
  const onFrame = (raw: unknown): void => {
    if (isStatusEvent(raw)) {
      if (raw.type === 'end') {
        release()
        stream = 'closed'
        revokeLive()
        return
      }
      const associationChanged = associations.observe(raw)
      setSnapshot(
        foldAgentSessionStatusEvent(snapshot, raw),
        foldAgentSessionConversationNames(names, raw),
        associationChanged
      )
      return
    }
    const refusal = streamRefusal(raw)
    if (refusal) {
      release()
      // A host with the feed but from before phones could read it answers `forbidden`.
      stream = isMobileMethodUnavailableError(refusal.code, refusal.message)
        ? 'unavailable'
        : 'closed'
      revokeLive()
    }
  }
  const open = (): void => {
    if (stream === 'closed' && listeners.size > 0) {
      associations.renew()
      stream = 'open'
      const dispose = client.subscribe('agentSession.subscribeStatus', {}, onFrame)
      // A stream that ended inside `subscribe` is released at once.
      if (stream === 'open') {
        releaseStream = dispose
      } else {
        dispose()
      }
    }
  }
  // Losing contact is never exit: only what a live host vouches for goes until it answers again.
  client.onStateChange((state) => {
    if (state === 'connected') {
      open()
      return
    }
    // The next connection may reach an updated host, so a refusal holds for one connection only.
    if (stream === 'unavailable') {
      stream = 'closed'
    }
    associations.renew()
    revokeLive()
  })
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      open()
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    getNamingSnapshot: () => names,
    getAssociationRevision: () => associations.revision
  }
}

export function mobileStructuredSessionStatusFeed(
  client: RpcClient
): MobileStructuredSessionStatusFeed {
  let feed = feeds.get(client)
  if (!feed) {
    feed = createFeed(client)
    feeds.set(client, feed)
  }
  return feed
}
