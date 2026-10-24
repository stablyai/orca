import { FakeAcpChild } from './acp-scripted-connection.test-fixture'
export { FakeAcpChild, PID } from './acp-scripted-connection.test-fixture'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { z } from 'zod'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
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
const RIG_ENV = { PATH: '/usr/bin', ORCA_PANE_KEY: 'tab-1:pane-1', ORCA_AGENT_HOOK_PORT: '1234' }
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
  started(): StructuredAgentSessionProviderOpenResult
  openFailure(): unknown
  settled: Parameters<NonNullable<AcpStructuredSessionAdapterDeps['onDispatchSettledLate']>>[0][]
  acquire(options?: {
    fence?: number
    onSpawned?: () => Promise<void>
    signal?: AbortSignal
    waitForStart?: boolean
    options?: Readonly<Record<string, string>>
    permissionMode?: AgentChatPermissionMode
  }): ReturnType<AcpStructuredSessionAdapter['acquire']>
  sent(method: string): FakeFrame[]
  frame(method: string, index?: number): Promise<FakeFrame>
  settle(): Promise<void>
}

export async function openAcpAdapterRig(
  options: {
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
  let openFailure: unknown
  let opened: StructuredAgentSessionProviderOpenResult | null = null
  const startListeners = new Set<() => void>()
  const spec = options.spec ?? GROK
  // Use a scratch account folder for agents that prepare one.
  const { prepare, resolve, environment } = spec.account
  const scratch = { launchEnv: {}, stateDirectory: tmpdir() }
  const account = prepare ? environment(await resolve(scratch), {}) : {}
  const resolveLaunch: AcpStructuredSessionAdapterDeps['resolveLaunch'] =
    options.deps?.resolveLaunch ??
    (async () => ({
      spec,
      command: `/opt/bin/${spec.command}`,
      args: spec.args({ fullAccess: false, pluginDir: null }),
      cwd: '/workspace/project',
      env: { ...RIG_ENV, ...account },
      envToDelete: [],
      fullAccess: false,
      resume: null,
      ...options.launch
    }))
  const adapter = new AcpStructuredSessionAdapter({
    spec,
    resolveLaunch,
    readLaunch: (identity) => resolveLaunch({ identity, spawnToken: 'recovery-read' }),
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
      let configOptions = GROK_CONFIG_OPTIONS
      agent.on('session/new', (frame) => agent.reply(frame, opened))
      agent.on('session/load', (frame) =>
        agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
      )
      agent.on('session/set_config_option', (frame) => {
        const parsed = z.object({ configId: z.string(), value: z.string() }).parse(frame.params)
        configOptions = configOptions.map((option) =>
          option.id === parsed.configId ? { ...option, currentValue: parsed.value } : option
        )
        agent.reply(frame, { configOptions })
      })
      if (spec.permissionModeConfig) {
        agent.confirmConfigOptions(GROK_CONFIG_OPTIONS)
      }
      options.script?.(agent)
      return child
    },
    readProcessStartTime: async () => 1_700_000_000_000,
    dataDirectory: join(tmpdir(), 'orca-acp-adapter-rig'),
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
      if (!opened) {
        throw new Error('ACP session has not started')
      }
      return opened
    },
    openFailure: () => openFailure,
    settled,
    acquire: async (acquireOptions = {}) => {
      openFailure = undefined
      opened = null
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
        ...(acquireOptions.signal ? { signal: acquireOptions.signal } : {}),
        ...(acquireOptions.permissionMode ? { permissionMode: acquireOptions.permissionMode } : {}),
        onSpawned: async () => {
          spawned.push('onSpawned')
          await acquireOptions.onSpawned?.()
        }
      })
      if (acquireOptions.waitForStart !== false) {
        try {
          opened = await adapter.open({
            sessionId: SESSION,
            fence: acquireOptions.fence ?? 1,
            acquisitionGeneration: acquisition.acquisitionGeneration,
            signal: acquireOptions.signal ?? new AbortController().signal
          })
        } catch (error) {
          openFailure = error
          await adapter.closeSession(SESSION)
        }
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

export function sendHello(rig: AcpAdapterRig, clientMessageId: string, fence = 1) {
  return rig.adapter.dispatch({ sessionId: SESSION, clientMessageId, body: HELLO, fence })
}

export function replyChunk(promptId: string, text: string, meta: Record<string, unknown> = {}) {
  return {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    _meta: { promptId, ...meta }
  }
}

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
