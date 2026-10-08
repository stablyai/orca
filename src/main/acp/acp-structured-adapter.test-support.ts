// A scripted ACP agent behind the real adapter: a fake connection over in-memory stdio, the real
// protocol runtime, translator and assembler, and a real on-disk journal to read back.

import { vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { ProviderProcessExit } from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  openProviderTimelineRig,
  SESSION,
  type ProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor, type AcpLaunchSpec } from './acp-launch-specs'
import { AcpScriptedAgent, tick, type FakeFrame } from './acp-scripted-agent.test-support'
import type { AcpAgentConnectionOptions } from './acp-agent-connection'
import { AcpConnectionClosedError } from './acp-errors'
import { AcpSessionRuntime } from './acp-session-runtime'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

export const GROK = acpLaunchSpecFor('grok')!
export const PROVIDER_SESSION = 'acp-session-1'
export const PID = 4242

export const GROK_CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'grok-4.7',
    options: [
      { value: 'grok-4.7', name: 'Grok 4.7' },
      { value: 'grok-4.6', name: 'Grok 4.6' }
    ]
  },
  {
    id: 'reasoning_effort',
    name: 'Reasoning Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'high', name: 'High' },
      { value: 'low', name: 'Low' }
    ]
  }
]

/** A scripted agent behind the connection surface: the real protocol runtime over in-memory stdio,
 *  with the process lifecycle `AcpAgentConnection` gives it (stdout EOF is not exit; the exit closes
 *  the protocol with the agent's last words; a protocol failure while it runs is `onClose`). */
export class FakeAcpChild extends AcpSessionRuntime implements AcpStructuredConnection {
  readonly agent: AcpScriptedAgent
  readonly pid: number | undefined = PID
  readonly spawned = Promise.resolve()
  stderr = ''
  processTreeUnproven = false
  private exitListeners: ((exit: ProviderProcessExit) => void)[] = []
  private gone = false
  private closing = false
  private lostWith: Error | undefined
  closes = 0

  constructor(
    readonly launch: ProviderProcessLaunch,
    private readonly connectionOptions: AcpAgentConnectionOptions,
    agent = new AcpScriptedAgent()
  ) {
    const lifecycle: { child: FakeAcpChild | null } = { child: null }
    super(agent.stdout, agent.stdin, {
      ...connectionOptions,
      peer: { ...connectionOptions.peer, closeOnInputEnd: false },
      onClose: (error) => lifecycle.child?.lost(error)
    })
    lifecycle.child = this
    this.agent = agent
  }

  get exited() {
    return this.gone
  }
  onExit(listener: (exit: ProviderProcessExit) => void): void {
    if (this.gone) {
      listener(FAKE_EXIT)
    } else {
      this.exitListeners.push(listener)
    }
  }
  stderrTail(): string {
    return this.stderr
  }
  pauseReading(): void {
    this.agent.stdout.pause()
  }
  resumeReading(): void {
    this.agent.stdout.resume()
  }
  /** What a close proves once the protocol is closed; replace it to leave the exit unproven. */
  proveClose = async (): Promise<boolean> => {
    this.exit()
    return true
  }
  override close(error?: Error): Promise<boolean> {
    this.closes += 1
    this.closing ||= !this.gone
    super.close(error)
    return this.proveClose()
  }
  /** The agent process ends on its own (or Orca's close landed). */
  exit(): void {
    if (this.gone) {
      return
    }
    this.gone = true
    const error =
      this.lostWith ?? new AcpConnectionClosedError(this.stderr || `${this.launch.command} exited`)
    super.close(error)
    this.connectionOptions.onExit?.(error, { expected: this.closing, exit: FAKE_EXIT })
    for (const listener of this.exitListeners.splice(0)) {
      listener(FAKE_EXIT)
    }
  }
  private lost(error: Error): void {
    this.lostWith ??= error
    if (this.closing || this.gone) {
      return
    }
    this.connectionOptions.onClose?.(error)
  }
}

const FAKE_EXIT: ProviderProcessExit = { code: 0, signal: null, processless: false }

export type AcpAdapterRig = {
  rig: ProviderTimelineRig
  adapter: AcpStructuredSessionAdapter
  child: () => FakeAcpChild
  spawned: string[]
  lifecycle: StructuredAgentSessionLifecycleEvent[]
  settled: Parameters<NonNullable<AcpStructuredSessionAdapterDeps['onDispatchSettledLate']>>[0][]
  acquire(options?: {
    fence?: number
    onSpawned?: () => Promise<void>
    signal?: AbortSignal
  }): ReturnType<AcpStructuredSessionAdapter['acquire']>
  /** Frames Orca wrote to the agent with this method. */
  sent(method: string): FakeFrame[]
  /** Waits for the `index`th frame Orca writes with this method. */
  frame(method: string, index?: number): Promise<FakeFrame>
  settle(): Promise<void>
}

export async function openAcpAdapterRig(
  options: {
    /** The agent's row; Grok's unless a test drives another agent. */
    spec?: AcpLaunchSpec
    launch?: Partial<AcpStructuredLaunch>
    initialize?: Record<string, unknown>
    script?: (agent: AcpScriptedAgent) => void
    deps?: Partial<AcpStructuredSessionAdapterDeps>
  } = {}
): Promise<AcpAdapterRig> {
  const rig = await openProviderTimelineRig()
  let current: FakeAcpChild | null = null
  const spawned: string[] = []
  const lifecycle: StructuredAgentSessionLifecycleEvent[] = []
  const settled: AcpAdapterRig['settled'] = []
  const spec = options.spec ?? GROK
  const adapter = new AcpStructuredSessionAdapter({
    spec,
    resolveLaunch: async () => ({
      spec,
      command: `/opt/bin/${spec.command}`,
      args: spec.args({ fullAccess: false, pluginDir: null }),
      cwd: '/workspace/project',
      env: { PATH: '/usr/bin', ORCA_PANE_KEY: 'tab-1:pane-1', ORCA_AGENT_HOOK_PORT: '1234' },
      envToDelete: [],
      fullAccess: false,
      resume: null,
      ...options.launch
    }),
    connect: (launch, connectionOptions) => {
      spawned.push('spawn')
      const child = new FakeAcpChild(launch, connectionOptions)
      current = child
      const { agent } = child
      agent.on('initialize', (frame) => {
        spawned.push('initialize')
        agent.reply(frame, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          ...options.initialize
        })
      })
      const opened = { sessionId: PROVIDER_SESSION, configOptions: GROK_CONFIG_OPTIONS }
      agent.on('session/new', (frame) => agent.reply(frame, opened))
      agent.on('session/load', (frame) =>
        agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
      )
      options.script?.(agent)
      return child
    },
    readProcessStartTime: async () => 1_700_000_000_000,
    onEvent: (event) => lifecycle.push(event),
    onDispatchSettledLate: (settlement) => settled.push(settlement),
    mintGeneration: () => 'gen-acp',
    now: () => 5_000,
    ...options.deps
  })
  const frames = () => current?.agent.frames ?? []
  return {
    rig,
    adapter,
    child: () => {
      if (!current) {
        throw new Error('no ACP child spawned')
      }
      return current
    },
    spawned,
    lifecycle,
    settled,
    acquire: (acquireOptions = {}) =>
      adapter.acquire({
        identity: {
          sessionId: SESSION,
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: spec.agent,
          providerHandle: null
        },
        fence: acquireOptions.fence ?? 1,
        spawnToken: 'spawn-1',
        events: rig.eventSink,
        ...(acquireOptions.signal ? { signal: acquireOptions.signal } : {}),
        onSpawned: async () => {
          spawned.push('onSpawned')
          await acquireOptions.onSpawned?.()
        }
      }),
    sent: (method) => frames().filter((frame) => frame.method === method),
    frame: (method, index = 0) =>
      waitFor(() => {
        const frame = frames().filter((entry) => entry.method === method)[index]
        if (!frame) {
          throw new Error(`no ${method} frame #${index} yet`)
        }
        return frame
      }),
    settle: async () => {
      for (let round = 0; round < 5; round += 1) {
        await tick()
      }
      await rig.rows()
    }
  }
}

const HELLO: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

/** A person's send of `hello` under `clientMessageId`. */
export function sendHello(rig: AcpAdapterRig, clientMessageId: string, fence = 1) {
  return rig.adapter.dispatch({ sessionId: SESSION, clientMessageId, body: HELLO, fence })
}

/** One streamed reply chunk of the turn Grok runs under `promptId`. */
export function replyChunk(promptId: string, text: string, meta: Record<string, unknown> = {}) {
  return {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    _meta: { promptId, ...meta }
  }
}

/** A shell command Grok runs inside the turn it runs under `promptId`. */
export function shellCall(promptId: string, status: 'in_progress' | 'completed') {
  return {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
      toolCallId: 'sleep-1',
      title: 'sleep 25; echo first-done',
      kind: 'execute',
      status
    },
    _meta: { promptId }
  }
}

export function waitFor<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 2_000, interval: 5 })
}
