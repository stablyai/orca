import { FakeAcpChild } from './acp-scripted-connection.test-fixture'
export { FakeAcpChild, PID } from './acp-scripted-connection.test-fixture'
// A scripted ACP agent behind the real adapter: a fake connection over in-memory stdio, the real
// protocol runtime, translator and assembler, and a real on-disk journal to read back.

import { vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionLifecycleEvent,
  StructuredAgentSessionStartedEvent
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  openProviderTimelineRig,
  SESSION,
  type ProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor, type AcpLaunchSpec } from './acp-launch-specs'
import { type AcpScriptedAgent, tick, type FakeFrame } from './acp-scripted-agent.test-support'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

export const GROK = acpLaunchSpecFor('grok')!
export const PROVIDER_SESSION = 'acp-session-1'

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

export type AcpAdapterRig = {
  rig: ProviderTimelineRig
  adapter: AcpStructuredSessionAdapter
  child: () => FakeAcpChild
  spawned: string[]
  lifecycle: StructuredAgentSessionLifecycleEvent[]
  readonly ended: Extract<StructuredAgentSessionLifecycleEvent, { type: 'ended' }>[]
  started(): StructuredAgentSessionStartedEvent
  settled: Parameters<NonNullable<AcpStructuredSessionAdapterDeps['onDispatchSettledLate']>>[0][]
  acquire(options?: {
    fence?: number
    onSpawned?: () => Promise<void>
    signal?: AbortSignal
    waitForStart?: boolean
    options?: Readonly<Record<string, string>>
    optionRevision?: () => number
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
  const startListeners = new Set<() => void>()
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
      agent.on('_x.ai/subagent/cancel', (frame) =>
        agent.fail(frame, -32602, 'Invalid params', 'invalid params: missing field `subagentId`')
      )
      agent.on('_x.ai/task/kill', (frame) =>
        agent.fail(frame, -32602, 'Invalid params', 'invalid params: missing field `sessionId`')
      )
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
    onDispatchSettledLate: (settlement) => settled.push(settlement),
    mintGeneration: () => 'gen-acp',
    now: () => 5_000,
    ...options.deps,
    onEvent: (event) => {
      lifecycle.push(event)
      for (const listener of startListeners) {
        listener()
      }
      options.deps?.onEvent?.(event)
    }
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
    get ended() {
      return lifecycle.filter((event) => event.type === 'ended')
    },
    started: () => {
      const event = lifecycle.findLast((entry) => entry.type === 'started')
      if (event?.type !== 'started') {
        throw new Error('ACP session has not started')
      }
      return event
    },
    settled,
    acquire: async (acquireOptions = {}) => {
      const beginning = lifecycle.length
      const acquisition = await adapter.acquire({
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
        ...(acquireOptions.options ? { options: acquireOptions.options } : {}),
        ...(acquireOptions.optionRevision ? { optionRevision: acquireOptions.optionRevision } : {}),
        ...(acquireOptions.signal ? { signal: acquireOptions.signal } : {}),
        onSpawned: async () => {
          spawned.push('onSpawned')
          await acquireOptions.onSpawned?.()
        }
      })
      if (acquireOptions.waitForStart !== false) {
        await new Promise<void>((resolve) => {
          const inspect = () => {
            if (
              lifecycle
                .slice(beginning)
                .some(
                  (event) =>
                    event.type !== 'options-reported' &&
                    event.acquisitionGeneration === acquisition.acquisitionGeneration
                )
            ) {
              startListeners.delete(inspect)
              resolve()
            }
          }
          startListeners.add(inspect)
          inspect()
        })
      }
      return acquisition
    },
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
