import { openCausalBridge } from './recording-bridge-observation'
import type {
  NativeObservation,
  AttemptObservation,
  Attempt,
  Parent
} from './recording-causality-contract'
export type {
  NativeObservation,
  BridgeReceiptObservation,
  BridgePostObservation,
  AttemptObservation
} from './recording-causality-contract'
import {
  BridgeClientNotReadyError,
  BridgeClientClosedError,
  BridgeClientCapExceededError,
  BridgeRequestOversizedError,
  BridgeSendFailedError,
  BridgeRpcEnvelopeInvalidError,
  BridgeRpcEnvelopeUngrantedError
} from '../../mobile-web-shell/bridge/bridge-client-errors'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { BridgePortObservation } from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { captureArguments } from './recording-values'
import type { RecordingFault } from './recording-fault'
import type { WriteOrdinal } from './write-ordinal'
import type { RpcClient } from '../../transport/rpc-client'

export class RecordingCausality {
  readonly parent = new AsyncLocalStorage<Parent>()
  private readonly native = new AsyncLocalStorage<NativeObservation>()
  private readonly attempts: Attempt[] = []
  private readonly bridgeChildren = new WeakSet<NativeObservation>()
  pairs = 0
  bridge = false
  closed = false

  constructor(
    readonly fault: RecordingFault,
    readonly ordinal: WriteOrdinal,
    readonly now: () => number
  ) {}

  attempt<T>(
    observation: AttemptObservation,
    args: Parameters<RpcClient['sendRequest']>,
    run: () => T
  ): T {
    const attempt: Attempt = {
      kind: 'attempt',
      observation,
      method: args[0],
      originalArgs: args,
      native: [],
      bridge: this.bridge
    }
    if (attempt.bridge) {
      observation.bridge = { posts: [] }
    }
    this.attempts.push(attempt)
    try {
      return this.parent.run(attempt, run)
    } finally {
      attempt.originalArgs = undefined
    }
  }

  invoke<T>(args: Parameters<typeof captureArguments>[0], run: (child: NativeObservation) => T): T {
    const child = this.fault.capture('native invocation', () => {
      if (this.closed) {
        throw new Error('Native invocation after recording closed')
      }
      const argsSnapshot = captureArguments(args)
      const parent = this.parent.getStore()
      if (!parent || (parent.kind !== 'attempt' && parent.kind !== 'message')) {
        throw new Error('Native invocation has no causal parent')
      }
      if (typeof args[0] !== 'string') {
        throw new Error('Native invocation has no method')
      }
      const attempt = parent.kind === 'message' ? parent.attempt : parent
      if (parent.kind === 'attempt' && attempt.bridge) {
        throw new Error('Bridge native invocation requires an actually delivered message')
      }
      if (
        parent.kind === 'attempt' &&
        (attempt.native.length ||
          attempt.method !== args[0] ||
          JSON.stringify(argsSnapshot) !== JSON.stringify(attempt.observation.args))
      ) {
        throw new Error('Transparent wrapper changed or added a native invocation')
      }
      const child: NativeObservation = {
        name:
          parent.kind === 'message'
            ? `${attempt.observation.name}.native-${parent.observation.children.length + 1}`
            : attempt.observation.name,
        method: args[0],
        ...(parent.kind === 'message'
          ? {
              parent: `${parent.observation.pair}:${parent.observation.document}:${parent.observation.post}`
            }
          : {}),
        ordinal: parent.kind === 'message' ? this.ordinal() : attempt.observation.ordinal,
        args: argsSnapshot,
        settlement: { status: 'pending', startedAt: this.now() }
      }
      attempt.native.push(child)
      if (parent.kind === 'message') {
        parent.observation.children.push(child)
        this.bridgeChildren.add(child)
      }
      return child
    })
    return this.native.run(child, () => run(child))
  }

  pageRejection(attempt: AttemptObservation, error: unknown): void {
    const page = attempt.bridge?.page
    if (!page) {
      return
    }
    try {
      const types = [
        BridgeClientNotReadyError,
        BridgeClientClosedError,
        BridgeClientCapExceededError,
        BridgeRequestOversizedError,
        BridgeSendFailedError,
        BridgeRpcEnvelopeInvalidError,
        BridgeRpcEnvelopeUngrantedError
      ]
      const actual = types.find(
        (type) => error instanceof type && Object.getPrototypeOf(error) === type.prototype
      )
      if (actual) {
        page.refusal = actual.name
      }
    } catch (observationError) {
      this.fault.report('actual page rejection origin', observationError)
    }
  }

  isBridgeChild(child: NativeObservation): boolean {
    return this.bridgeChildren.has(child)
  }

  currentNative(): NativeObservation {
    const child = this.native.getStore()
    if (!child || this.closed) {
      throw new Error('Unbound physical request')
    }
    return child
  }

  openBridge(): BridgePortObservation {
    return openCausalBridge(this)
  }

  assertTransparentCalls(): void {
    this.fault.capture('wrapper cardinality', () => {
      for (const attempt of this.attempts) {
        if (attempt.native.some((child) => child.settlement.status === 'pending')) {
          throw new Error(
            `Recording retained a live native continuation: ${attempt.observation.name}`
          )
        }
        if (!attempt.bridge && attempt.native.length !== 1) {
          throw new Error(`Transparent wrapper swallowed ${attempt.observation.name}`)
        }
        if (attempt.bridge && !attempt.observation.bridge?.page) {
          throw new Error(`Bridge wrapper swallowed ${attempt.observation.name}`)
        }
      }
    })
  }

  close(): void {
    this.closed = true
    this.parent.disable()
    this.native.disable()
  }
}
