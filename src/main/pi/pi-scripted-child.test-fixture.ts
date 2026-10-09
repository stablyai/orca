import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import type { JsonlRpcAgentConnectionOptions } from '../jsonl-rpc/agent-connection'
import { JsonlRpcResponseError, type JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { ScriptedAgentChild } from '../runtime/structured-agent-scripted-child.test-fixture'
import type { PiRpcConnection } from './rpc-session'

class ScriptedPiConnection implements PiRpcConnection {
  closed = false
  rootVerdict: PiRpcConnection['rootVerdict'] = 'live'
  processless = false
  lastCloseResult: PiRpcConnection['lastCloseResult'] = null
  readonly pid: number
  readonly file: string
  private readonly handshake = Promise.withResolvers<unknown>()
  private readonly exitListeners = new Set<() => void>()
  private firstStateRead = true
  private streaming = false
  private model = { provider: 'scripted', id: 'model-1', reasoning: true }
  private effort = 'medium'

  constructor(
    launch: ProviderProcessLaunch,
    private readonly handlers: JsonlRpcAgentConnectionOptions,
    private readonly script: ScriptedAgentChild,
    private readonly received: string[],
    private readonly wire: string[],
    private readonly onClosed: () => void,
    number: number
  ) {
    this.pid = 42_000 + number
    const sessionIndex = launch.args.indexOf('--session')
    this.file =
      sessionIndex !== -1
        ? launch.args[sessionIndex + 1]
        : join(tmpdir(), 'orca-scripted-pi', `session-${number}.jsonl`)
    void this.handshake.promise.catch(() => undefined)
  }

  async request(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) {
      throw new Error('Scripted Pi connection closed')
    }
    this.wire.push(command)
    if (command === 'get_state') {
      if (this.firstStateRead) {
        this.firstStateRead = false
        if (!this.script.holdHandshakes) {
          this.releaseHandshake()
        }
        return this.handshake.promise
      }
      return this.state()
    }
    if (command === 'get_available_models') {
      return { models: [this.model] }
    }
    if (command === 'get_commands') {
      return { commands: [] }
    }
    if (
      command === 'set_model' &&
      typeof params.provider === 'string' &&
      typeof params.modelId === 'string'
    ) {
      this.model = { ...this.model, provider: params.provider, id: params.modelId }
      return this.model
    }
    if (command === 'set_thinking_level' && typeof params.level === 'string') {
      this.effort = params.level
      return {}
    }
    if (command === 'abort') {
      this.endTurn('aborted')
      return {}
    }
    throw new Error(`Unscripted Pi request: ${command}`)
  }

  async send(frame: JsonlRpcRecord): Promise<void> {
    if (this.closed || frame.type !== 'prompt' || typeof frame.message !== 'string') {
      throw new Error('Scripted Pi requires a live prompt')
    }
    this.received.push(frame.message)
    this.wire.push(`prompt:${frame.message}`)
    if (!this.streaming) {
      this.streaming = true
      this.emit({ type: 'agent_start' })
    }
    this.emit({ type: 'message_end', message: { role: 'user', content: frame.message } })
    this.emit({
      type: 'response',
      command: 'prompt',
      success: true,
      data: { disposition: 'started' }
    })
    if (this.script.completeTurns) {
      this.endTurn('stop')
    }
  }

  releaseHandshake(): void {
    if (!this.closed) {
      this.handshake.resolve(this.state())
    }
  }

  failHandshake(message: string): void {
    const error = withProviderDiagnostic(
      new JsonlRpcResponseError('get_state', message),
      providerDiagnostic(message, 'person')
    )
    this.handshake.reject(error)
    this.exit(error)
  }

  async close(): Promise<Awaited<ReturnType<PiRpcConnection['close']>>> {
    if (!this.closed) {
      this.onClosed()
      const error = new Error('Scripted Pi closed')
      this.handshake.reject(error)
      this.exit(error)
    }
    return { root: 'exited', tree: 'exited' }
  }

  onExit(listener: () => void): void {
    if (this.rootVerdict === 'exited') {
      listener()
    } else {
      this.exitListeners.add(listener)
    }
  }

  pauseReading(): void {}
  resumeReading(): void {}

  private exit(error: Error): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.rootVerdict = 'exited'
    this.lastCloseResult = { root: 'exited', tree: 'exited' }
    this.exitListeners.forEach((listener) => listener())
    this.exitListeners.clear()
    this.handlers.onExit?.(error, {
      expected: false,
      exit: { code: 0, signal: null, processless: false }
    })
  }

  private endTurn(stopReason: string): void {
    if (!this.streaming) {
      return
    }
    this.streaming = false
    this.emit({
      type: 'message_end',
      message: { role: 'assistant', content: 'Scripted Pi reply', stopReason }
    })
    this.emit({ type: 'agent_end' })
    this.emit({ type: 'agent_settled' })
  }

  private emit(frame: JsonlRpcRecord): void {
    this.handlers.onRecord?.(frame)
  }

  private state() {
    return {
      sessionFile: this.file,
      model: this.model,
      thinkingLevel: this.effort,
      isStreaming: this.streaming,
      isCompacting: false,
      pendingMessageCount: 0
    }
  }
}

export type ScriptedPiChild = ScriptedAgentChild & {
  /** Every request command and prompt any spawn received, in order. */
  wire(): readonly string[]
}

export const piScriptedChild = (): ScriptedPiChild => {
  const children: ScriptedPiConnection[] = []
  const received: string[] = []
  const wire: string[] = []
  let resumed = 0
  let closed = 0
  const script: ScriptedPiChild = {
    holdHandshakes: true,
    completeTurns: true,
    deps: {
      resolvePiLaunch: async (identity) => {
        const handle = identity.providerHandle
        if (handle && (handle.transport !== 'jsonl-rpc' || handle.agent !== 'pi')) {
          throw new Error('Scripted Pi received another provider handle')
        }
        return {
          command: join(tmpdir(), 'orca-scripted-pi', 'fake-pi'),
          cwd: tmpdir(),
          fullAccess: true,
          previous: handle
            ? {
                linkId: 'scripted-previous',
                handle,
                origin: 'created',
                mintedAtFence: 0,
                observedAt: Date.now()
              }
            : null,
          ...(handle ? { sessionFile: handle.nativeId } : {})
        }
      },
      openPiConnection: (launch, handlers) => {
        if (launch.args.includes('--session')) {
          resumed += 1
        }
        const child = new ScriptedPiConnection(
          launch,
          handlers,
          script,
          received,
          wire,
          () => {
            closed += 1
          },
          children.length + 1
        )
        children.push(child)
        return child
      },
      readProcessStartTime: async () => 1_700_000_000_000
    },
    releaseHandshake: () => children.at(-1)?.releaseHandshake(),
    failHandshake: (message) => children.at(-1)?.failHandshake(message),
    prompts: () => received,
    spawns: () => children.length,
    resumes: () => resumed,
    closes: () => closed,
    wire: () => wire
  }
  return script
}
