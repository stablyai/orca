import { utf8ByteLength } from './bridge-caps'
import { BridgeReplyRefusedError } from './bridge-client-errors'
import type { BridgeRpcClientDiagnostic } from './bridge-client-diagnostics'
import type { BridgeClientRequests } from './bridge-client-requests'
import type { BridgeClientSubscriptions } from './bridge-client-subscriptions'
import {
  readBridgeHostMessage,
  readRefusedBridgeFrameId,
  type BridgeConnectionSnapshot,
  type BridgeHostMessage
} from './bridge-envelope'
import { reconstructBridgeError } from './bridge-error-capture'

export type BridgeInboundFramePort = {
  requests: BridgeClientRequests
  subscriptions: BridgeClientSubscriptions
  report: (diagnostic: BridgeRpcClientDiagnostic) => void
  acceptInit: (message: Extract<BridgeHostMessage, { type: 'init' }>) => void
  acceptState: (connection: BridgeConnectionSnapshot) => void
  /** One Back press from the shell, for whoever in this document claimed the key. */
  acceptBack: () => void
}

/** The shell's own words where it had any, the way the native client passes an RPC error message
 *  through to the listener it ends. */
function describeStreamFailure(error: unknown): string {
  return error instanceof Error ? error.message : 'the shell could not keep this stream open'
}

/**
 * One frame from the shell, routed to whatever the page has open under the id it names.
 *
 * Every exchange the page opens ends here or nowhere: a frame this reader cannot read is still an
 * answer, and dropping it silently left the request it settled waiting for the life of the
 * document. What the reader refuses it reports and then settles; what it accepts it dispatches.
 */
export function createBridgeInboundFrameReader(
  port: BridgeInboundFramePort
): (json: string) => void {
  const { requests, subscriptions, report } = port

  /**
   * The shell answers a refused `subscribe` with `error` on the stream's id. Nothing is pending to
   * reject there, so routing it to the requests would drop it and hold the page's slot forever.
   *
   * `shellRetiredStream` is what separates the two ways a stream dies. An `error` or an `end` is the
   * shell saying it has already let go, and a `cancel` back would say the same thing twice. A frame
   * this reader refused is not that: the shell is still serving the stream, so the page has to ask
   * it to stop or the slot is held on both sides.
   */
  function failExchange(id: string, error: unknown, shellRetiredStream: boolean): void {
    if (subscriptions.has(id)) {
      // Reported before the listener runs, so a listener that throws cannot swallow the diagnostic.
      report({ kind: 'stream-failed', error })
      const message = describeStreamFailure(error)
      if (shellRetiredStream) {
        subscriptions.end(id, message, error)
      } else {
        subscriptions.abandon(id, message, error)
      }
      return
    }
    if (!requests.has(id)) {
      report({ kind: 'unknown-id' })
    }
    // Still routed: an id with a half-assembled reply behind it holds a slot until it is discarded.
    requests.fail(id, error)
  }

  function dispatch(message: BridgeHostMessage, json: string): void {
    switch (message.type) {
      case 'init':
        port.acceptInit(message)
        return
      case 'state':
        port.acceptState(message.connection)
        return
      case 'back':
        port.acceptBack()
        return
      case 'reply':
        if (!requests.has(message.id)) {
          report({ kind: 'unknown-id' })
        }
        requests.acceptReply(message)
        return
      case 'error':
        failExchange(message.id, reconstructBridgeError(message.error), true)
        return
      case 'event':
        subscriptions.deliver(message, utf8ByteLength(json))
        return
      case 'end':
        report({ kind: 'stream-ended', reason: message.reason })
        subscriptions.end(message.id, `the shell ended this stream (${message.reason})`)
        return
    }
  }

  return (json: string): void => {
    const read = readBridgeHostMessage(json)
    if (read.ok) {
      dispatch(read.message, json)
      return
    }
    report({ kind: 'refused', refusal: read.refusal })
    // Only an exchange the page is already holding is settled, so an id salvaged from a frame this
    // reader has refused reaches nothing the page did not open itself.
    const id = readRefusedBridgeFrameId(json)
    if (id !== null && (requests.has(id) || subscriptions.has(id))) {
      failExchange(id, new BridgeReplyRefusedError(read.refusal), false)
    }
  }
}
