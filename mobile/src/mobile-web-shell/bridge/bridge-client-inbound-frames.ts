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
  acceptBack: () => void
}

function describeStreamFailure(error: unknown): string {
  return error instanceof Error ? error.message : 'the shell could not keep this stream open'
}

// Settle refused replies instead of silently dropping them and stranding requests; accepted frames dispatch to the exchange their id names.
export function createBridgeInboundFrameReader(
  port: BridgeInboundFramePort
): (json: string) => void {
  const { requests, subscriptions, report } = port

  // Route subscribe errors to streams, not pending requests. Shell error/end already retired the stream; reader refusal must cancel it at the shell to release both slots.
  function failExchange(id: string, error: unknown, shellRetiredStream: boolean): void {
    if (subscriptions.has(id)) {
      // Report before invoking a listener that could throw and hide the diagnostic.
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
    // Salvaged ids can settle only exchanges the page already opened, never create an exchange from a refused frame.
    const id = readRefusedBridgeFrameId(json)
    if (id !== null && (requests.has(id) || subscriptions.has(id))) {
      failExchange(id, new BridgeReplyRefusedError(read.refusal), false)
    }
  }
}
