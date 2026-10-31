import { scriptedNativeRequest } from './scripted-native-request'
import {
  scriptedFrame,
  scriptedOutstanding,
  scriptedBind,
  scriptedComplete,
  scriptedLateReply
} from './scripted-response-delivery'
import {
  scriptedSession,
  scriptedRegisteredStreams,
  scriptedDeliverToListener,
  scriptedTakeListenerCrash
} from './scripted-native-session'
import {
  scriptedNextFrameId,
  scriptedOccurrence,
  scriptedPublish,
  createScriptedRequestTracker
} from './scripted-request-tracker'
import { RecordingFault } from './recording-fault'
import {
  RecordingCausality,
  type AttemptObservation,
  type NativeObservation
} from './recording-causality'
import type { BridgePortObservation } from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import type { ConnectionState, RpcResponse } from '../../transport/types'
import type { RpcClient } from '../../transport/rpc-client'
import { RpcClientStreamRegistry } from '../../transport/rpc-client-stream-registry'
import { createStableLogicalRpcClient } from '../../transport/stable-logical-rpc-client'
import {
  captureArguments,
  captureError,
  observeSettlement,
  type RecordedValue
} from './recording-values'
import { createWriteOrdinal, type WriteOrdinal } from './write-ordinal'
import type { Rejection } from './recording-scenario'

export type FrameListenerCrash = { readonly error: unknown }

type SendRequestArgs = Parameters<RpcClient['sendRequest']>
// This fixture models request/bridge causality with shared connection state, not physical session or server lifetime.
// Accept a wrapper function to avoid loading bridge product code into native recording.
export type ScriptedClientWrapper = (
  client: RpcClient,
  observation: {
    openBridge: () => BridgePortObservation
    onDispose: (cleanup: () => void | Promise<void>) => void
  }
) => RpcClient

/** The one device identity every recorded frame carries; nothing here reads a keychain. */

export class ScriptedRpcTransport {
  stoppedGuard: { error: unknown; evidence: RecordedValue } | undefined
  readonly requests: AttemptObservation[] = []
  readonly payloads: { name: string; ordinal: number; json: string }[] = []
  readonly client: RpcClient
  readonly logical
  readonly wrapperCleanup: (() => void | Promise<void>)[] = []
  counts = new Map<string, number>()
  bindings = new Map<
    string,
    { id: string; method: string; params: unknown; completed: boolean; child: NativeObservation }
  >()
  aliases = new Map<string, string>()
  openStreams = new Map<
    string,
    { id: string; params: unknown; deliver: (response: RpcResponse) => boolean }
  >()
  readonly registries: RpcClientStreamRegistry[] = []
  // Track every published id/name, including unsubscribes, for registry teardown observations.
  readonly streamPayloads = new Map<string, string>()
  readonly fault: RecordingFault
  readonly causality: RecordingCausality
  listenerCrash: FrameListenerCrash | null = null
  frameCount = 0
  state: ConnectionState = 'connected'
  listeners = new Set<(state: ConnectionState) => void>()
  rejects = new Map<string, (error: Error) => void>()
  tracker = createScriptedRequestTracker(this)

  constructor(
    readonly now: () => number = () => 0,
    readonly nextWriteOrdinal: WriteOrdinal = createWriteOrdinal(),
    wrapClient: ScriptedClientWrapper = (client) => client,
    fault = new RecordingFault(),
    readonly waitForConnected?: () => Promise<void>,
    onAcquired?: (transport: ScriptedRpcTransport) => void
  ) {
    this.fault = fault
    this.causality = new RecordingCausality(fault, nextWriteOrdinal, now)
    onAcquired?.(this)
    const session = this.session()
    this.logical = createStableLogicalRpcClient(session, 'lan')
    const inner = wrapClient(
      {
        ...this.logical,
        sendRequest: (...args: SendRequestArgs) => scriptedNativeRequest(this, args)
      },
      {
        openBridge: () => this.causality.openBridge(),
        onDispose: (cleanup) => this.wrapperCleanup.push(cleanup)
      }
    )
    this.client = {
      ...inner,
      sendRequest: (...args: SendRequestArgs) => {
        const captured = this.fault.capture('outer arguments', () => captureArguments(args))
        const name = this.occurrence(args[0])
        const request: AttemptObservation = {
          name,
          ordinal: this.fault.capture('outer ordinal', () => this.nextWriteOrdinal()),
          args: captured,
          settlement: { status: 'pending', startedAt: this.now() }
        }
        this.requests.push(request)
        let promise: Promise<RpcResponse>
        try {
          promise = this.causality.attempt(request, args, () => inner.sendRequest(...args))
        } catch (error) {
          this.causality.pageRejection(request, error)
          request.settlement = this.fault.capture('synchronous settlement', () => ({
            status: 'rejected',
            startedAt: request.settlement.startedAt,
            settledAt: this.now(),
            error: captureError(error)
          }))
          throw error
        }
        observeSettlement(
          promise,
          this.now,
          (state) => {
            request.settlement = state
          },
          (error) => this.fault.report('outer settlement', error),
          (error) => this.causality.pageRejection(request, error)
        )
        return promise
      }
    }
  }

  session(): RpcClient {
    return scriptedSession(this)
  }

  nextFrameId(): string {
    return scriptedNextFrameId(this)
  }

  // Read the real registry after product cleanup; mirrored bookkeeping could hide leaks it is meant to detect.
  registeredStreams(): { method: string; payload: string | null; cancelled: boolean }[] {
    return scriptedRegisteredStreams(this)
  }

  // Stash and rethrow listener failures unchanged so frame can record them without swallowing registry/scenario failures.
  deliverToListener(onData: (result: unknown) => void, result: unknown): void {
    return scriptedDeliverToListener(this, onData, result)
  }

  /** Reads the stash through the declared type, which assigning it in `frame` would narrow away. */
  takeListenerCrash(): FrameListenerCrash | null {
    return scriptedTakeListenerCrash(this)
  }

  occurrence(method: string): string {
    return scriptedOccurrence(this, method)
  }

  publish(name: string, value: unknown): { name: string; ordinal: number; json: string } {
    return scriptedPublish(this, name, value)
  }

  // Deliver whole responses through the real stream registry.
  // Record product listener crashes, while missing payloads, mismatched params and registry failures remain scenario errors.
  frame(name: string, params: unknown, reply: unknown): FrameListenerCrash | null {
    return scriptedFrame(this, name, params, reply)
  }

  outstanding(name: string): { params: unknown } | undefined {
    return scriptedOutstanding(this, name)
  }

  bind(alias: string, name: string, params: unknown): void {
    return scriptedBind(this, alias, name, params)
  }

  complete(name: string, params: unknown, reply: unknown, rejection?: Rejection): void {
    return scriptedComplete(this, name, params, reply, rejection)
  }

  disconnect(): void {
    this.state = 'disconnected'
    this.tracker.rejectAll('Connection lost', { deliveryUnknown: true })
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  lateReply(name: string, reply: unknown): boolean {
    return scriptedLateReply(this, name, reply)
  }

  async cutover(): Promise<void> {
    await this.logical.migrateTo(this.session(), 'relay')
  }

  pendingRequests(): number {
    return this.tracker.size()
  }

  failureGuard(error: unknown): RecordedValue | undefined {
    return this.stoppedGuard && this.stoppedGuard.error === error
      ? this.stoppedGuard.evidence
      : undefined
  }

  check(): void {
    this.fault.check()
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = []
    for (const cleanup of [
      () => this.client?.close(),
      () => this.logical?.close(),
      ...this.wrapperCleanup.splice(0)
    ]) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 1) {
      throw errors[0]
    }
    if (errors.length) {
      throw new AggregateError(errors, 'Scripted transport cleanup failed')
    }
  }
}
