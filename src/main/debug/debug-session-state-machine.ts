import { EventEmitter } from 'node:events'
import type { DebugSessionState } from '../../shared/debug-session-types'
import type { DapEventMessage } from './dap-client'

export class DebugSessionStateMachineError extends Error {}

/**
 * The slice of `DapClient` the state machine depends on — a standalone
 * interface (not `Pick<DapClient, ...>`) so tests can supply a fake without
 * touching wire framing: `Pick` would inherit `on`/`off`'s `this`-typed
 * EventEmitter return type pinned to the concrete `DapClient` class, which a
 * structurally-compatible fake can't satisfy.
 */
export type DapTransport = {
  request(command: string, args?: unknown): Promise<unknown>
  close(): void
  on(event: string, listener: (...args: any[]) => void): DapTransport
  off(event: string, listener: (...args: any[]) => void): DapTransport
}

export type LaunchRequest = {
  request: 'launch' | 'attach'
  args: Record<string, unknown>
}

/**
 * Drives a `DapClient` through the DAP session lifecycle in the order the
 * protocol requires — `initialize` -> `launch`/`attach` -> `configurationDone`
 * -> `running`/`paused` -> `terminate` — rejecting calls that arrive out of
 * order instead of forwarding them to the adapter process.
 */
export class DebugSessionStateMachine extends EventEmitter {
  private readonly client: DapTransport
  private stateValue: DebugSessionState = 'initializing'

  constructor(client: DapTransport) {
    super()
    this.client = client
    this.client.on('event', (msg: DapEventMessage) => this.handleAdapterEvent(msg))
    this.client.on('close', () => this.setState('terminated'))
  }

  get state(): DebugSessionState {
    return this.stateValue
  }

  async initialize(args: Record<string, unknown>): Promise<unknown> {
    this.assertState('initializing', 'initialize')
    const capabilities = await this.client.request('initialize', args)
    this.setState('launching')
    return capabilities
  }

  async launch(request: LaunchRequest): Promise<void> {
    this.assertState('launching', request.request)
    await this.client.request(request.request, request.args)
    this.setState('configuring')
  }

  async configurationDone(): Promise<void> {
    this.assertState('configuring', 'configurationDone')
    await this.client.request('configurationDone')
    this.setState('running')
  }

  /** `setBreakpoints`/`setExceptionBreakpoints` are valid both before `configurationDone` and while the program is live. */
  async setBreakpoints(args: Record<string, unknown>): Promise<unknown> {
    if (!isConfiguringOrLive(this.stateValue)) {
      throw new DebugSessionStateMachineError(
        `Cannot send "setBreakpoints" while session is "${this.stateValue}"`
      )
    }
    return this.client.request('setBreakpoints', args)
  }

  async continue(threadId: number): Promise<void> {
    this.assertLive('continue')
    await this.client.request('continue', { threadId })
  }

  async pause(threadId: number): Promise<void> {
    this.assertLive('pause')
    await this.client.request('pause', { threadId })
  }

  async stepOver(threadId: number): Promise<void> {
    this.assertLive('next')
    await this.client.request('next', { threadId })
  }

  async stepInto(threadId: number): Promise<void> {
    this.assertLive('stepIn')
    await this.client.request('stepIn', { threadId })
  }

  async stepOut(threadId: number): Promise<void> {
    this.assertLive('stepOut')
    await this.client.request('stepOut', { threadId })
  }

  async evaluate(args: Record<string, unknown>): Promise<unknown> {
    this.assertLive('evaluate')
    return this.client.request('evaluate', args)
  }

  async getThreads(): Promise<unknown> {
    this.assertLive('threads')
    return this.client.request('threads')
  }

  async getStackTrace(threadId: number): Promise<unknown> {
    this.assertLive('stackTrace')
    return this.client.request('stackTrace', { threadId })
  }

  async getVariables(variablesReference: number): Promise<unknown> {
    this.assertLive('variables')
    return this.client.request('variables', { variablesReference })
  }

  /** Always allowed (except once already terminating/terminated) — terminate is the escape hatch from any lifecycle stage. */
  async terminate(): Promise<void> {
    if (this.stateValue === 'terminating' || this.stateValue === 'terminated') {
      return
    }
    this.setState('terminating')
    try {
      await this.client.request('disconnect', { terminateDebuggee: true })
    } finally {
      this.client.close()
      this.setState('terminated')
    }
  }

  private handleAdapterEvent(msg: DapEventMessage): void {
    this.emit('event', msg)
    if (msg.event === 'stopped') {
      this.setState('paused')
    } else if (msg.event === 'continued') {
      this.setState('running')
    } else if (msg.event === 'terminated' || msg.event === 'exited') {
      this.setState('terminated')
    }
  }

  private assertLive(command: string): void {
    if (this.stateValue !== 'running' && this.stateValue !== 'paused') {
      throw new DebugSessionStateMachineError(
        `Cannot send "${command}" while session is "${this.stateValue}"`
      )
    }
  }

  private assertState(expected: DebugSessionState, command: string): void {
    if (this.stateValue !== expected) {
      throw new DebugSessionStateMachineError(
        `Cannot send "${command}" while session is "${this.stateValue}" (expected "${expected}")`
      )
    }
  }

  private setState(next: DebugSessionState): void {
    if (this.stateValue === next) {
      return
    }
    this.stateValue = next
    this.emit('stateChanged', next)
  }
}

function isConfiguringOrLive(state: DebugSessionState): boolean {
  return state === 'configuring' || state === 'running' || state === 'paused'
}
