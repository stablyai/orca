import { readBridgeClientMessage } from './bridge/bridge-envelope'
import { frameWithoutHostLine } from './shell-bridge-log-lines'
import { recordShellLifecycleLine } from './shell-lifecycle-line-recorder'

export type FrameWithoutHostFacts = { hostId: string; clientReady: boolean; snapshotReady: boolean }

export type PageFramesWithoutHost = {
  /** A frame no host serves yet; `facts` is null when a retired session's host is still mounted. */
  receive: (sessionId: string, json: string, facts: FrameWithoutHostFacts | null) => void
  /** Hands the page's latest ready for this session to the host just built for it, once. */
  replayReady: (sessionId: string, host: { receive: (json: string) => void }) => void
}

// Keep the ready instead of dropping it, so init does not wait on the page's 50 ms to 2 s backoff.
export function createPageFramesWithoutHost(): PageFramesWithoutHost {
  let loggedSessionId: string | null = null
  let ready: { sessionId: string; json: string } | null = null
  return {
    receive: (sessionId, json, facts) => {
      if (facts !== null && loggedSessionId !== sessionId) {
        loggedSessionId = sessionId
        recordShellLifecycleLine(facts.hostId, frameWithoutHostLine(facts))
      }
      const read = readBridgeClientMessage(json)
      if (read.ok && read.message.type === 'ready') {
        ready = { sessionId, json }
      } else if (read.ok && read.message.type === 'close') {
        // The document that asked is gone, so its ready must not be answered.
        ready = null
      }
    },
    replayReady: (sessionId, host) => {
      const kept = ready
      ready = null
      if (kept?.sessionId === sessionId) {
        host.receive(kept.json)
      }
    }
  }
}
