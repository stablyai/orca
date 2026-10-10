import type { BackgroundTransientFactRelay } from './daemon-background-transient-facts'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { TerminalHost } from './terminal-host'

type DaemonSessionBackgroundRoutingOptions = {
  host: TerminalHost
  attachments: DaemonSessionAttachments
  transientFactRelay: BackgroundTransientFactRelay
  streamDataBatcher: DaemonStreamDataBatcher
}

export class DaemonSessionBackgroundRouting {
  constructor(private readonly options: DaemonSessionBackgroundRoutingOptions) {}

  setBackground(sessionId: string, background: boolean): Record<string, never> {
    recordDaemonStreamBacklogEvent('setSessionBackground', {
      sessionIdSuffix: sessionId.slice(-10),
      background
    })
    const changed = this.options.transientFactRelay.setSessionBackground(sessionId, background)
    this.options.streamDataBatcher.refreshSessionDroppability(sessionId)
    if (!changed) {
      return {}
    }
    if (background) {
      this.options.transientFactRelay.seedSessionScanState(
        sessionId,
        this.options.host.getPartialEscapeTailAnsi(sessionId)
      )
    }
    const streamClientId = this.options.attachments.clientIdForSession(sessionId)
    if (!streamClientId) {
      return {}
    }
    const mode2031State = this.options.transientFactRelay.getMode2031ReplyScanState(sessionId)
    const scanSeedAnsi = background
      ? ''
      : mode2031State.pendingSubscribe
        ? mode2031State.tail
        : this.options.host.getPartialEscapeTailAnsi(sessionId)
    this.options.streamDataBatcher.enqueueControlEvent(streamClientId, sessionId, {
      type: 'event',
      event: 'sessionBackgroundMarker',
      sessionId,
      payload: {
        background,
        ...(scanSeedAnsi.length > 0 ? { scanSeedAnsi } : {}),
        ...(mode2031State.pendingSubscribe ? { mode2031PendingSubscribe: true as const } : {})
      }
    })
    return {}
  }
}
