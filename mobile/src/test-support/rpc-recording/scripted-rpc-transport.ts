import type { ConnectionState, RpcResponse } from '../../transport/types'
import type { RpcClient } from '../../transport/rpc-client'
import { RpcClientRequestTracker } from '../../transport/rpc-client-request-tracker'
import { createStableLogicalRpcClient } from '../../transport/stable-logical-rpc-client'
import { markRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import {
  captureArguments,
  captureValue,
  observeSettlement,
  type Settlement
} from './recording-values'
import type { Rejection } from './recording-scenario'

export class ScriptedRpcTransport {
  readonly requests: {
    name: string
    args: ReturnType<typeof captureArguments>
    settlement: Settlement
  }[] = []
  readonly payloads: { name: string; json: string }[] = []
  readonly client: RpcClient
  readonly logical
  private counts = new Map<string, number>()
  private bindings = new Map<string, { id: string; params: unknown; completed: boolean }>()
  private aliases = new Map<string, string>()
  private activeName = ''
  private frameCount = 0
  private state: ConnectionState = 'connected'
  private listeners = new Set<(state: ConnectionState) => void>()
  private rejects = new Map<string, (error: Error) => void>()
  private tracker = new RpcClientRequestTracker({
    nextId: () => `frame-${++this.frameCount}`,
    getState: () => this.state,
    waitForConnected: async () => {
      if (this.state !== 'connected') {
        throw new Error('Scripted transport disconnected')
      }
    },
    deviceToken: 'recording-device',
    sendEncrypted: (value) => {
      const payload = value as { id: string; method: string; params: unknown }
      const name = this.wireNames.shift()
      if (!name) {
        throw new Error('Unbound physical request')
      }
      this.bindings.set(name, { id: payload.id, params: payload.params, completed: false })
      this.payloads.push({ name, json: JSON.stringify(value) })
      return true
    }
  })
  private wireNames: string[] = []

  constructor() {
    const session = this.session()
    this.logical = createStableLogicalRpcClient(session, 'lan')
    this.client = {
      ...this.logical,
      sendRequest: (...args: Parameters<RpcClient['sendRequest']>) => {
        const occurrence = (this.counts.get(args[0]) ?? 0) + 1
        this.counts.set(args[0], occurrence)
        const name = `${args[0]}#${occurrence}`
        this.activeName = name
        const request = {
          name,
          args: captureArguments(args),
          settlement: { status: 'pending' } as Settlement
        }
        this.requests.push(request)
        const promise = this.logical.sendRequest(...args)
        observeSettlement(promise, (state) => {
          request.settlement = state
        })
        return promise
      }
    }
  }

  private session(): RpcClient {
    return {
      sendRequest: (...args) => {
        const name = this.activeName
        this.wireNames.push(name)
        return new Promise<RpcResponse>((resolve, reject) => {
          this.rejects.set(name, reject)
          this.tracker.sendRequest(...args).then(resolve, reject)
        })
      },
      subscribe: () => {
        throw new Error('Subscriptions are outside this request-only runner')
      },
      updateTerminalSubscriptionViewport: () => {},
      getState: () => this.state,
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => 0,
      onStateChange: (listener) => {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      },
      notifyForeground: () => {},
      close: () => {
        this.tracker.rejectAll('Connection closed', { deliveryUnknown: true })
      }
    }
  }

  bind(alias: string, name: string, params: unknown): void {
    name = this.aliases.get(name) ?? name
    const binding = this.bindings.get(name)
    if (!binding || this.aliases.has(alias)) {
      throw new Error(`Invalid request binding: ${alias}`)
    }
    if (JSON.stringify(captureValue(binding.params)) !== JSON.stringify(captureValue(params))) {
      throw new Error(`Binding params mismatch: ${alias}`)
    }
    this.aliases.set(alias, name)
  }

  complete(name: string, params: unknown, reply: unknown, rejection?: Rejection): void {
    const alias = this.aliases.get(name)
    const requestedName = alias ?? name
    const method = requestedName.split('#')[0]
    if (
      !alias &&
      [...this.bindings].filter(([key, value]) => key.split('#')[0] === method && !value.completed)
        .length > 1
    ) {
      throw new Error(`Concurrent requests require a logical binding: ${name}`)
    }
    name = requestedName
    const binding = this.bindings.get(name)
    if (!binding || binding.completed) {
      throw new Error(`Missing or completed request: ${name}`)
    }
    if (JSON.stringify(captureValue(binding.params)) !== JSON.stringify(captureValue(params))) {
      throw new Error(`Request params mismatch: ${name}`)
    }
    binding.completed = true
    if (rejection) {
      const error =
        rejection.category === 'TypeError'
          ? new TypeError(rejection.message)
          : new Error(rejection.message)
      if (rejection.deliveryUnknown) {
        markRpcDeliveryUnknown(error)
      }
      // Resolve the physical tracker to cancel its deadline before injecting the scripted rejection.
      this.rejects.get(name)?.(error)
      this.tracker.resolve({ id: binding.id, ok: true, result: null } as RpcResponse)
    } else {
      this.tracker.resolve({ ...(reply as object), id: binding.id } as RpcResponse)
    }
  }

  disconnect(): void {
    this.state = 'disconnected'
    this.tracker.rejectAll('Connection lost', { deliveryUnknown: true })
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  async cutover(): Promise<void> {
    await this.logical.migrateTo(this.session(), 'relay')
  }

  dispose(): void {
    this.logical.close()
  }
}
