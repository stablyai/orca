import type { ConnectionState, RpcResponse } from '../../transport/types'
import type { RpcClient } from '../../transport/rpc-client'
import { buildDirectRpcWireRequest } from '../../transport/rpc-envelope-fields'
import { RpcClientRequestTracker } from '../../transport/rpc-client-request-tracker'
import { RpcClientStreamRegistry } from '../../transport/rpc-client-stream-registry'
import { createStableLogicalRpcClient } from '../../transport/stable-logical-rpc-client'
import { markRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import {
  captureArguments,
  captureValue,
  observeSettlement,
  type Settlement
} from './recording-values'
import { createWriteOrdinal, type WriteOrdinal } from './write-ordinal'
import type { Rejection } from './recording-scenario'

type FrameListenerCrash = { readonly error: unknown }

type SendRequestArgs = Parameters<RpcClient['sendRequest']>

// Keep recorder instrumentation below injected transports so wrapped and native recordings remain comparable.
// Accept a wrapper function to avoid loading bridge product code into native recording.
export type ScriptedClientWrapper = (client: RpcClient) => RpcClient

/** The one device identity every recorded frame carries; nothing here reads a keychain. */
const DEVICE_TOKEN = 'recording-device'

export class ScriptedRpcTransport {
  readonly requests: {
    name: string
    ordinal: number
    args: ReturnType<typeof captureArguments>
    settlement: Settlement
  }[] = []
  readonly payloads: { name: string; ordinal: number; json: string }[] = []
  readonly client: RpcClient
  readonly logical
  private counts = new Map<string, number>()
  private bindings = new Map<string, { id: string; params: unknown; completed: boolean }>()
  private aliases = new Map<string, string>()
  private openStreams = new Map<
    string,
    { id: string; params: unknown; deliver: (response: RpcResponse) => boolean }
  >()
  private readonly registries: RpcClientStreamRegistry[] = []
  // Track every published id/name, including unsubscribes, for registry teardown observations.
  private readonly streamPayloads = new Map<string, string>()
  private activeName = ''
  // Queue logical names: asynchronous forwarding can leave multiple calls waiting for physical sends.
  private names: string[] = []
  private opening = false
  private listenerCrash: FrameListenerCrash | null = null
  private frameCount = 0
  private state: ConnectionState = 'connected'
  private listeners = new Set<(state: ConnectionState) => void>()
  private rejects = new Map<string, (error: Error) => void>()
  private tracker = new RpcClientRequestTracker({
    nextId: () => this.nextFrameId(),
    getState: () => this.state,
    waitForConnected: async () => {
      if (this.state !== 'connected') {
        throw new Error('Scripted transport disconnected')
      }
    },
    sendFrame: (frame) => {
      const payload = buildDirectRpcWireRequest(frame, DEVICE_TOKEN)
      const name = this.wireNames.shift()
      if (!name) {
        throw new Error('Unbound physical request')
      }
      this.bindings.set(name, { id: payload.id, params: payload.params, completed: false })
      this.publish(name, payload)
      return true
    }
  })
  private wireNames: string[] = []

  constructor(
    private readonly now: () => number = () => 0,
    private readonly nextWriteOrdinal: WriteOrdinal = createWriteOrdinal(),
    wrapClient: ScriptedClientWrapper = (client) => client
  ) {
    const session = this.session()
    this.logical = createStableLogicalRpcClient(session, 'lan')
    const inner = wrapClient({
      ...this.logical,
      sendRequest: (...args: SendRequestArgs) => {
        // Dequeue at physical forwarding so same-turn asynchronous sends retain their own names; missing/extra sends fail.
        const name = this.names.shift() ?? '(no logical request)'
        if (name.slice(0, name.lastIndexOf('#')) !== args[0]) {
          throw new Error(`A physical send of ${args[0]} cannot take the name ${name}`)
        }
        this.activeName = name
        return this.logical.sendRequest(...args)
      }
    })
    this.client = {
      ...inner,
      // Stamp outside the wrapper to time the operation’s logical call rather than delayed forwarding.
      sendRequest: (...args: SendRequestArgs) => {
        const name = this.occurrence(args[0])
        this.names.push(name)
        const request = {
          name,
          ordinal: this.nextWriteOrdinal(),
          args: captureArguments(args),
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a pending settlement has no settledAt yet.
          settlement: { status: 'pending', startedAt: this.now() } as Settlement
        }
        this.requests.push(request)
        const promise = inner.sendRequest(...args)
        observeSettlement(promise, this.now, (state) => {
          request.settlement = state
        })
        return promise
      }
    }
  }

  private session(): RpcClient {
    // Keep one stream registry per physical session; logical requests survive cutover while streams belong to their opening session.
    const streams: RpcClientStreamRegistry = new RpcClientStreamRegistry({
      nextId: () => this.nextFrameId(),
      getState: () => this.state,
      sendFrame: (frame) => {
        const payload = buildDirectRpcWireRequest(frame, DEVICE_TOKEN)
        const name = this.occurrence(payload.method)
        // Only subscribe opens streams; treating unsubscribe as one would let a frame silently reach no listener.
        if (this.opening) {
          this.openStreams.set(name, {
            id: payload.id,
            params: payload.params,
            deliver: (response) => streams.handleResponse(response)
          })
        }
        // Update replayed ids too so teardown names the latest physical occurrence.
        this.streamPayloads.set(payload.id, name)
        this.publish(name, payload)
        return true
      }
    })
    this.registries.push(streams)
    return {
      sendRequest: (...args) => {
        const name = this.activeName
        this.wireNames.push(name)
        return new Promise<RpcResponse>((resolve, reject) => {
          this.rejects.set(name, reject)
          this.tracker.sendRequest(...args).then(resolve, reject)
        })
      },
      subscribe: (method, params, onData, options) => {
        this.opening = true
        try {
          return streams.subscribe(
            method,
            params,
            (result) => this.deliverToListener(onData, result),
            options
          )
        } finally {
          this.opening = false
        }
      },
      updateTerminalSubscriptionViewport: (terminal, viewport) =>
        streams.updateTerminalViewport(terminal, viewport),
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

  private nextFrameId(): string {
    return `frame-${++this.frameCount}`
  }

  // Read the real registry after product cleanup; mirrored bookkeeping could hide leaks it is meant to detect.
  registeredStreams(): { method: string; payload: string | null; cancelled: boolean }[] {
    return this.registries.flatMap((registry) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shape is checked on the next line, and the registry is the one this transport constructed.
      const streams = (registry as unknown as { streams?: unknown }).streams
      if (!(streams instanceof Map)) {
        throw new Error('RpcClientStreamRegistry no longer holds its open streams in `streams`')
      }
      return [...streams].map(
        ([id, stream]: [string, { method?: unknown; cancelled?: unknown }]) => {
          if (typeof stream.method !== 'string') {
            throw new Error(`Registered stream ${id} has no method`)
          }
          // Cancelled records await an unsubscribe id; only uncancelled records imply missed cleanup.
          return {
            method: stream.method,
            payload: this.streamPayloads.get(id) ?? null,
            cancelled: stream.cancelled === true
          }
        }
      )
    })
  }

  // Stash and rethrow listener failures unchanged so frame can record them without swallowing registry/scenario failures.
  private deliverToListener(onData: (result: unknown) => void, result: unknown): void {
    try {
      onData(result)
    } catch (error) {
      this.listenerCrash = { error }
      throw error
    }
  }

  /** Reads the stash through the declared type, which assigning it in `frame` would narrow away. */
  private takeListenerCrash(): FrameListenerCrash | null {
    const crash = this.listenerCrash
    this.listenerCrash = null
    return crash
  }

  private occurrence(method: string): string {
    const next = (this.counts.get(method) ?? 0) + 1
    this.counts.set(method, next)
    return `${method}#${next}`
  }

  private publish(name: string, value: unknown): void {
    this.payloads.push({ name, ordinal: this.nextWriteOrdinal(), json: JSON.stringify(value) })
  }

  // Deliver whole responses through the real stream registry.
  // Record product listener crashes, while missing payloads, mismatched params and registry failures remain scenario errors.
  frame(name: string, params: unknown, reply: unknown): FrameListenerCrash | null {
    const stream = this.openStreams.get(name)
    if (!stream) {
      throw new Error(`Missing subscription payload: ${name}`)
    }
    if (JSON.stringify(captureValue(stream.params)) !== JSON.stringify(captureValue(params))) {
      throw new Error(`Subscribe params mismatch: ${name}`)
    }
    this.takeListenerCrash()
    let routed = false
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scenario supplies the response as JSON; the wire id is the transport’s.
      routed = stream.deliver({ ...(reply as object), id: stream.id } as RpcResponse)
    } catch (error) {
      // Record only the listener’s own throw; registry errors mean the scenario stopped matching.
      const crashed = this.takeListenerCrash()
      if (!crashed || crashed.error !== error) {
        throw error
      }
      return crashed
    }
    const crash = this.takeListenerCrash()
    if (crash) {
      return crash
    }
    if (!routed) {
      // Streaming frames always route to the opening id; reaching here with a non-streaming reply means the scenario mismatched.
      throw new Error(`No open stream for frame: ${name}`)
    }
    return null
  }

  outstanding(name: string): { params: unknown } | undefined {
    const binding = this.bindings.get(this.aliases.get(name) ?? name)
    return binding && !binding.completed ? binding : undefined
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scenario asked for a null result, which is a reply shape a host can send.
      this.tracker.resolve({ id: binding.id, ok: true, result: null } as RpcResponse)
    } else {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scenario supplies the reply as JSON; the wire id is the transport’s.
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
