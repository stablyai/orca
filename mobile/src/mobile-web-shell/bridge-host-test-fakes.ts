import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { BRIDGE_PROTOCOL_VERSION } from './bridge/bridge-envelope'

export type SentRequest = {
  method: string
  /** The arity the host used, which the golden recorder reads as part of the call. */
  args: readonly unknown[]
  resolve: (response: RpcResponse) => void
  reject: (error: unknown) => void
}

export type OpenStream = {
  method: string
  params: unknown
  emit: (payload: unknown) => void
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
    'getState' | 'getReconnectAttempt' | 'getLastConnectedAt' | 'getLastInboundAt' | 'getGeneration'
  >
>

/** Every call the host can make, recorded; nothing settles until the test says so. */
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
    subscribe: (method, params, onData) => {
      const stream: OpenStream = { method, params, emit: onData, unsubscribes: 0 }
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

/** 22 chars of base64url, which is what the envelope's id pattern accepts. */
export function bridgeId(index: number): string {
  return index.toString(36).padStart(22, 'a')
}

export function clientFrame(fields: Record<string, unknown>): string {
  return JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, ...fields })
}

export function rpcSuccess(id: string, result: unknown): RpcResponse {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-a' } }
}

/** Two microtask turns: a settled `sendRequest` posts from a `then`, and a post rejection is
 *  reported from a `catch` chained onto it. */
export async function flushBridge(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
