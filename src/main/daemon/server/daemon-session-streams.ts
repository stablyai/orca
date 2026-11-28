import { salvageDroppedDaemonStreamQueries } from '../transport/stream/daemon-stream-query-salvage'
import {
  BackgroundTransientFactRelay,
  BACKGROUND_STREAM_DROP_ENABLED
} from '../transport/stream/daemon-background-transient-facts'
import { DaemonStreamDataBatcher } from '../transport/stream/daemon-stream-data-batcher'
import type { DaemonClientConnections } from './daemon-client-connections'
import { sendDaemonTransientFact } from './daemon-transient-fact-delivery'
import { DaemonSessionAttachments } from './daemon-session-attachments'
import type { TerminalHost } from '../terminal-host/terminal-host'
import type { DaemonFileLog } from '../observability/daemon-file-log'

type SessionStreamParts = {
  host: TerminalHost
  connections: () => DaemonClientConnections
  log: DaemonFileLog
}

/** PTY output to attached clients: the batcher plus background facts that share its order. */
export function createDaemonSessionStreams(parts: SessionStreamParts): {
  attachments: DaemonSessionAttachments
  transientFactRelay: BackgroundTransientFactRelay
  streamDataBatcher: DaemonStreamDataBatcher
} {
  const attachments = new DaemonSessionAttachments(parts.host)
  const transientFactRelay = new BackgroundTransientFactRelay((sessionId, fact) =>
    sendDaemonTransientFact(attachments, streamDataBatcher, sessionId, fact)
  )
  const streamDataBatcher = new DaemonStreamDataBatcher(
    (clientId) => parts.connections().get(clientId),
    {
      onProducerBackpressureChanged: (sessionId, paused, onStallTimeout) =>
        paused
          ? parts.host.pauseProducer(sessionId, 'stream', onStallTimeout)
          : parts.host.resumeProducer(sessionId, 'stream'),
      isSessionAttachedToClient: (clientId, sessionId) => {
        const owner = attachments.clientIdForSession(sessionId)
        return owner === undefined || owner === clientId
      },
      isSessionDroppable: (sessionId) =>
        BACKGROUND_STREAM_DROP_ENABLED && transientFactRelay.isBackgrounded(sessionId),
      salvageDroppedData: salvageDroppedDaemonStreamQueries,
      onLongProducerPause: (details) => parts.log.log('terminal-output-paused', details),
      incarnationOf: (sessionId) => parts.host.sessionIncarnation(sessionId)
    }
  )
  return { attachments, transientFactRelay, streamDataBatcher }
}
