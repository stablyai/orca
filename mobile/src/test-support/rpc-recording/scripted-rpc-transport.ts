import type { ConnectionState, RpcResponse } from '../../transport/types'
import type { RpcClient } from '../../transport/rpc-client'
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

/** What a product stream listener threw on one delivered frame. */
type FrameListenerCrash = { readonly error: unknown }

/** Named once so the two layers of the seam spell the operation's own call the same way. */
type SendRequestArgs = Parameters<RpcClient['sendRequest']>

/**
 * Puts another transport between the operation being recorded and this one. The recorder's own
 * instrumentation stays underneath, so the wrapped client is a transport under test rather than a
 * substitute for this one: `requests`, `payloads` and the scripted replies are all still observed
 * here, and a golden recorded through a wrapper is comparable to the one recorded without it.
 *
 * Declared as a function rather than as an import of the thing that uses it. The page bridge lives
 * in `mobile/src/mobile-web-shell/`, which is inside the recorder's own fence, so the engine naming
 * it would put a product module in `recorderSha256`; `rpc-recording-through-bridge.test.ts` builds
 * the pair and hands it in instead.
 */
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
  /**
   * Wire id to the name of the last payload the registry published under it. Every frame it sends
   * lands here, unsubscribes included, because `registeredStreams()` only ever looks up an id the
   * registry still holds and an unsubscribed id is not one of those.
   */
  private readonly streamPayloads = new Map<string, string>()
  private activeName = ''
  /**
   * Logical request names waiting for the physical send that will carry them. A queue rather than
   * one slot because a wrapped transport may forward a send asynchronously, and two sends issued in
   * one turn would overwrite a slot before either reached the wire. Exactly one name is pushed per
   * logical `sendRequest` and exactly one is taken by the physical call it wraps, in the order the
   * operation made them.
   */
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
    deviceToken: DEVICE_TOKEN,
    sendEncrypted: (value) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the physical client publishes the frame this transport just serialized.
      const payload = value as { id: string; method: string; params: unknown }
      const name = this.wireNames.shift()
      if (!name) {
        throw new Error('Unbound physical request')
      }
      this.bindings.set(name, { id: payload.id, params: payload.params, completed: false })
      this.publish(name, value)
      return true
    }
  })
  private wireNames: string[] = []

  /**
   * `now` is the recording scheduler's virtual clock; every settlement is stamped from it.
   * `nextWriteOrdinal` is the recording's one write counter, shared with its effects.
   * `wrapClient` puts a transport under test between the operation and this one; see its type.
   */
  constructor(
    private readonly now: () => number = () => 0,
    private readonly nextWriteOrdinal: WriteOrdinal = createWriteOrdinal(),
    wrapClient: ScriptedClientWrapper = (client) => client
  ) {
    const session = this.session()
    this.logical = createStableLogicalRpcClient(session, 'lan')
    // The sandwich the seam is: the recorder observes the operation's own call on the outside, the
    // wrapper carries it, and the inside hands it to the logical client with its name attached.
    const inner = wrapClient({
      ...this.logical,
      sendRequest: (...args: SendRequestArgs) => {
        // Taken here rather than above the wrapper so `session()` still reads exactly one name per
        // physical send: a wrapper that forwards on a microtask arrives after the next logical call
        // has been made, and one slot would hand both sends the second name. Both ways of getting
        // that wrong throw rather than guess: a wrapper that invents a send finds the queue empty,
        // and one that swallows a send leaves a name whose method is not the one now on the wire.
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
      // Outermost on purpose. `ordinal` orders this call against the recording's device writes and
      // physical payloads, and the operation makes it at the same moment either way; stamping it
      // under the wrapper would time the wrapper's forwarded send, an event the unwrapped recording
      // has no counterpart for, and every send would read one write late.
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
    // One registry per physical session, the way `DirectRpcClient` builds one: the tracker is shared
    // because a logical request outlives a cutover, a stream does not. Byte-neutral either way — the
    // re-send after a cutover comes from the logical client's own replay — but it keeps a frame
    // routed through the session that published its subscribe.
    const streams: RpcClientStreamRegistry = new RpcClientStreamRegistry({
      nextId: () => this.nextFrameId(),
      deviceToken: DEVICE_TOKEN,
      getState: () => this.state,
      sendEncrypted: (value) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stream registry publishes the frame it just built.
        const payload = value as { id: string; method: string; params: unknown }
        const name = this.occurrence(payload.method)
        // Only a subscribe opens a stream. The registry sends its unsubscribes through this same
        // hook, and filing one under `openStreams` made a frame aimed at an unsubscribe name route
        // at that id, find nothing, record nothing and not throw.
        if (this.opening) {
          this.openStreams.set(name, {
            id: payload.id,
            params: payload.params,
            deliver: (response) => streams.handleResponse(response)
          })
        }
        // Outside the `opening` guard on purpose: a replay after a cutover re-sends an
        // already-registered id under a fresh occurrence, so the latest payload is the one a
        // teardown observation should name.
        this.streamPayloads.set(payload.id, name)
        this.publish(name, value)
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

  /**
   * Every stream each session's registry still holds, in registration order, named by the subscribe
   * payload it was opened on. Read off the registry's own map rather than mirrored as the recorder
   * watches subscribes and frames go by: the leak this exists to observe is precisely a divergence
   * between what the product believes it closed and what the registry still holds, and a mirror
   * would reproduce the product's bookkeeping instead of observing it.
   */
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
          // A cancelled record is the product having closed the stream and the registry holding it
          // until the subscription id it needs to unsubscribe with arrives; only an uncancelled one
          // is a cleanup that never ran.
          return {
            method: stream.method,
            payload: this.streamPayloads.get(id) ?? null,
            cancelled: stream.cancelled === true
          }
        }
      )
    })
  }

  /**
   * The product's stream listener, wrapped so `frame` can tell a dead listener from a dead registry.
   * The throw is stashed and rethrown unchanged: the registry has to see it the way a device's
   * message handler does, so what it skips after a listener dies is recorded rather than invented.
   */
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

  /** One occurrence counter per method, so a subscribe payload is named the way a request is. */
  private occurrence(method: string): string {
    const next = (this.counts.get(method) ?? 0) + 1
    this.counts.set(method, next)
    return `${method}#${next}`
  }

  private publish(name: string, value: unknown): void {
    this.payloads.push({ name, ordinal: this.nextWriteOrdinal(), json: JSON.stringify(value) })
  }

  /**
   * A whole host response delivered at a subscribe payload's wire id, through the real registry, so
   * `ready`, a data event, `end` and a refusal are one step kind rather than four.
   *
   * What the product listener threw is returned rather than thrown on, because the two failures a
   * frame can produce have to stay apart. A missing payload, a params mismatch and a closed stream
   * are the scenario no longer matching and stay loud. A listener that dies on a frame is the
   * recording — the same rule the crash boundary holds for a screen, and without it the reply
   * shapes that break a subscription are the only ones this oracle cannot see: only three
   * listeners check the payload is an object before reading its `type` — the two
   * `runtime.clientEvents` ones and the structured agent session's, which guards with
   * `isSubscribeEvent` — so the absent-result and null-result partitions take every other one down.
   */
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
      // Only the product listener's own throw is a recording; anything the registry raised on its
      // way to the listener is the scenario no longer matching, and stays loud.
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
      // Only a non-streaming reply lands here: the registry routes every streaming response to the
      // id that opened the stream, retired or not. A scenario that has stopped matching, not a
      // stream that closed early.
      throw new Error(`No open stream for frame: ${name}`)
    }
    return null
  }

  /** Whether a scripted name names a request that was sent and is still waiting for its reply. */
  outstanding(name: string): boolean {
    const binding = this.bindings.get(this.aliases.get(name) ?? name)
    return binding !== undefined && !binding.completed
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
