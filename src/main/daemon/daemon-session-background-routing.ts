import type { BackgroundTransientFactRelay } from './daemon-background-transient-facts'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { TerminalHost } from './terminal-host'
import { SessionNotFoundError } from './daemon-errors'
import { setDaemonTerminalViewAttributes } from './daemon-view-attributes'
import type {
  SetSessionQueryResponderRequest,
  SetTerminalViewAttributesRequest
} from './daemon-pty-owner-query-protocol'

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

  /** v45 responder requests: the viewer's attributes, or one session's responder flipped at this
   *  byte position and reported to main in byte order. */
  routeQueryResponder(
    request: SetTerminalViewAttributesRequest | SetSessionQueryResponderRequest
  ): Record<string, never> {
    if (request.type === 'setTerminalViewAttributes') {
      setDaemonTerminalViewAttributes(request.payload.attributes)
      return {}
    }
    const { sessionId } = request.payload
    const responder = request.payload.responder === true
    let applied = true
    try {
      this.options.host.setSessionQueryResponder(
        sessionId,
        responder ? { nativeWindowsConpty: request.payload.nativeWindowsConpty === true } : null
      )
    } catch (error) {
      // Why: a vanished session answers nothing, which its marker must tell main.
      if (!(error instanceof SessionNotFoundError)) {
        throw error
      }
      applied = false
    }
    const streamClientId = this.options.attachments.clientIdForSession(sessionId)
    if (streamClientId) {
      this.options.streamDataBatcher.enqueueControlEvent(streamClientId, sessionId, {
        type: 'event',
        event: 'sessionQueryResponderMarker',
        sessionId,
        payload: { responder: responder && applied }
      })
    }
    return {}
  }
}
