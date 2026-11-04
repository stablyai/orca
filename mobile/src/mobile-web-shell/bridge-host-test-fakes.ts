import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import type { BrowserScreencastFrame } from '../transport/browser-screencast-protocol'
import type { RpcEnvelopeFields } from '../transport/rpc-envelope-fields'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { BRIDGE_PROTOCOL_VERSION } from './bridge/bridge-envelope'

export type SentRequest = {
  method: string
  args: readonly unknown[]
  resolve: (response: RpcResponse) => void
  reject: (error: unknown) => void
}

export type OpenStream = {
  method: string
  params: unknown
  emit: (payload: unknown) => void
  emitBinary: ((frame: BrowserScreencastFrame) => void) | null
  envelope: RpcEnvelopeFields | undefined
  unsubscribes: number
}

export type FakeRpcClient = RpcClient & {
  readonly requests: SentRequest[]
  readonly streams: OpenStream[]
  readonly foregroundCalls: (readonly unknown[])[]
  readonly viewports: { terminal: string; cols: number; rows: number }[]
  pushState: (state: ConnectionState) => void
  stateListeners: () => number
}

type ClientGetters = Partial<
  Pick<
    RpcClient,
    | 'getState'
    | 'getReconnectAttempt'
    | 'getLastConnectedAt'
    | 'getLastInboundAt'
    | 'getGeneration'
    | 'getActivePath'
    | 'getPendingPath'
    | 'getRelayHostReachability'
    | 'onConnectionPathChange'
  >
>

export function createFakeRpcClient(getters: ClientGetters = {}): FakeRpcClient {
  const requests: SentRequest[] = []
  const streams: OpenStream[] = []
  const foregroundCalls: (readonly unknown[])[] = []
  const viewports: { terminal: string; cols: number; rows: number }[] = []
  const listeners = new Set<(state: ConnectionState) => void>()
  return {
    sendRequest: (...args: [string, unknown?, SendRequestOptions?]) =>
      new Promise<RpcResponse>((resolve, reject) => {
        requests.push({ method: args[0], args, resolve, reject })
      }),
    subscribe: (method, params, onData, options) => {
      const stream: OpenStream = {
        method,
        params,
        emit: onData,
        emitBinary: options?.onBinaryFrame ?? null,
        envelope: options?.envelope,
        unsubscribes: 0
      }
      streams.push(stream)
      return () => {
        stream.unsubscribes += 1
      }
    },
    updateTerminalSubscriptionViewport: (terminal, viewport) => {
      viewports.push({ terminal, cols: viewport.cols, rows: viewport.rows })
    },
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notifyForeground: (...args: Parameters<RpcClient['notifyForeground']>) => {
      foregroundCalls.push(args)
    },
    close: () => undefined,
    requests,
    streams,
    foregroundCalls,
    viewports,
    pushState: (state) => {
      for (const listener of listeners) {
        listener(state)
      }
    },
    stateListeners: () => listeners.size,
    ...getters
  }
}

export function bridgeId(index: number): string {
  return index.toString(36).padStart(22, 'a')
}

export function clientFrame(fields: Record<string, unknown>): string {
  return JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, ...fields })
}

export function rpcSuccess(id: string, result: unknown): RpcResponse {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-a' } }
}

// Drain request-then-post and its chained rejection catch across two microtask turns.
export async function flushBridge(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

// The shell forwards an ordinary request's method, params and the page's options, adding only its
// local pre-send fence; compare those, and the fence's kind, without reaching into it.
export function shellLocalCall([method, params, options]: readonly unknown[]): unknown[] {
  const forwarded: Record<string, unknown> = {}
  let fence = 'undefined'
  if (typeof options === 'object' && options !== null) {
    for (const [key, value] of Object.entries(options)) {
      if (key === 'beforeSend') {
        fence = typeof value
      } else {
        forwarded[key] = value
      }
    }
  }
  return [method, params, forwarded, fence]
}

// The shell's pre-send fence: it takes nothing and throws to refuse the send.
type PreSendFence = () => void

function isPreSendFence(value: unknown): value is PreSendFence {
  return typeof value === 'function'
}

// The fence the shell passed with a forwarded request.
export function shellFence([, , options]: readonly unknown[]): PreSendFence {
  if (typeof options === 'object' && options !== null && 'beforeSend' in options) {
    const { beforeSend } = options
    if (isPreSendFence(beforeSend)) {
      return beforeSend
    }
  }
  throw new Error('The shell passed no pre-send fence')
}
