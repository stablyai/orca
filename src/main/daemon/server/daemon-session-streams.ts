import { salvageDroppedDaemonStreamQueries } from '../transport/stream/daemon-stream-query-salvage'
import {
  BackgroundTransientFactRelay,
  BACKGROUND_STREAM_DROP_ENABLED
} from '../transport/stream/daemon-background-transient-facts'
import { DaemonStreamDataBatcher } from '../transport/stream/daemon-stream-data-batcher'
import type { DaemonClientConnections } from './daemon-client-connections'
import { sendDaemonTransientFact } from './daemon-transient-fact-delivery'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import type { TerminalHost } from '../terminal-host/terminal-host'

type SessionStreamParts = {
  host: () => TerminalHost
  attachments: () => DaemonSessionAttachments
  connections: () => DaemonClientConnections
}

/** PTY output to attached clients: the batcher plus background facts that share its order. */
export function createDaemonSessionStreams(parts: SessionStreamParts): {
  transientFactRelay: BackgroundTransientFactRelay
  streamDataBatcher: DaemonStreamDataBatcher
} {
  const transientFactRelay = new BackgroundTransientFactRelay((sessionId, fact) =>
    sendDaemonTransientFact(parts.attachments(), streamDataBatcher, sessionId, fact)
  )
  const streamDataBatcher = new DaemonStreamDataBatcher(
    (clientId) => parts.connections().get(clientId),
    {
      onProducerBackpressureChanged: (sessionId, paused, onStallTimeout) =>
        paused
          ? parts.host().pauseProducer(sessionId, 'stream', onStallTimeout)
          : parts.host().resumeProducer(sessionId, 'stream'),
      isSessionAttachedToClient: (clientId, sessionId) => {
        const owner = parts.attachments().clientIdForSession(sessionId)
        return owner === undefined || owner === clientId
      },
      isSessionDroppable: (sessionId) =>
        BACKGROUND_STREAM_DROP_ENABLED && transientFactRelay.isBackgrounded(sessionId),
      salvageDroppedData: salvageDroppedDaemonStreamQueries
    }
  )
  return { transientFactRelay, streamDataBatcher }
}
