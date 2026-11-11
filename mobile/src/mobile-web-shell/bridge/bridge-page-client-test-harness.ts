import {
  BRIDGE_PROTOCOL_VERSION,
  readBridgeClientMessage,
  type BridgeClientMessage,
  type BridgeHostMessage
} from './bridge-envelope'
import { createBridgeRpcClient, type BridgeRpcClientDiagnostic } from './bridge-rpc-client'

export const CONNECTION = {
  state: 'connected',
  reconnectAttempt: 2,
  lastConnectedAt: 1700,
  lastInboundAt: 1800,
  generation: 5
} as const

export const GRANTS = { rpc: { maxPendingRequests: 64, maxSubscriptions: 32 }, native: [] }

// Keep INIT narrowed to its union member so tests can read grants without assertion.
export const INIT: Extract<BridgeHostMessage, { type: 'init' }> = {
  v: BRIDGE_PROTOCOL_VERSION,
  type: 'init',
  sessionId: 'session-a',
  buildId: 'build-a',
  connection: CONNECTION,
  grants: GRANTS
}

type PageClientOptions = {
  send?: (json: string) => void
  // Ignore unsubscribe to expose late-read guards after cleanup.
  keepDeliveringAfterUnsubscribe?: boolean
}

export function createPageClient(options: PageClientOptions = {}) {
  const sent: string[] = []
  const diagnostics: BridgeRpcClientDiagnostic[] = []
  let handler: ((json: string) => void) | null = null
  const client = createBridgeRpcClient({
    send: (json) => {
      sent.push(json)
      options.send?.(json)
    },
    onMessage: (received) => {
      handler = received
      return () => {
        if (options.keepDeliveringAfterUnsubscribe !== true) {
          handler = null
        }
      }
    },
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic)
    }
  })
  return {
    client,
    sent,
    diagnostics,
    deliver(frame: unknown): void {
      handler?.(JSON.stringify(frame))
    },
    deliverRaw(json: string): void {
      handler?.(json)
    },
    frames(): BridgeClientMessage[] {
      return sent.map((json) => {
        const read = readBridgeClientMessage(json)
        if (!read.ok) {
          throw new Error(`the shell would have refused this frame: ${read.refusal}`)
        }
        return read.message
      })
    },
    start(): void {
      this.deliver(INIT)
    }
  }
}

export function readError(thrown: unknown): Error {
  if (!(thrown instanceof Error)) {
    throw new Error(`expected an Error, got ${typeof thrown}`)
  }
  return thrown
}

export function eventFrame(id: string, seq: number, payload: unknown): BridgeHostMessage {
  return { v: BRIDGE_PROTOCOL_VERSION, type: 'event', id, seq, payload }
}

export function idOf(page: ReturnType<typeof createPageClient>, index: number): string {
  const frame = page.frames().filter((message) => 'id' in message)[index]
  if (frame === undefined || !('id' in frame)) {
    throw new Error('the page opened no such exchange')
  }
  return frame.id
}
