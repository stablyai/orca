import { expect, vi, type Mock } from 'vitest'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { JsonlRpcAgentConnectionOptions } from '../jsonl-rpc/agent-connection'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import type { PiRpcConnection } from './rpc-session'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { PiRpcSessionAdapter, type PiRpcSessionAdapterDeps } from './rpc-session-adapter'
import type { PiRpcResolvedLaunch } from './rpc-launch-resolution'

export const sessionId = 'session-timeline'
export const file = '/host/account/sessions/session.jsonl'
export const state = {
  sessionFile: file,
  isStreaming: false,
  isCompacting: false,
  model: { provider: 'anthropic', id: 'model-1' }
}
const cleanups: (() => Promise<void>)[] = []
export async function closePiRpcAdapterFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  await closeProviderTimelineRigs()
}

export class FakeConnection implements PiRpcConnection {
  pid = 4123
  closed = false
  rootVerdict: 'live' | 'unverifiable' | 'exited' = 'live'
  processless = false
  deferExit = false
  closeError?: Error
  lastCloseResult: PiRpcConnection['lastCloseResult'] = null
  closeResult: Awaited<ReturnType<PiRpcConnection['close']>> = { root: 'exited', tree: 'exited' }
  readonly sent: JsonlRpcRecord[] = []
  readonly requests: string[] = []
  private readonly exitListeners: (() => void)[] = []
  requestOverride?: (command: string) => Promise<unknown> | undefined
  abortRequest?: () => void
  constructor(readonly handlers: JsonlRpcAgentConnectionOptions) {}
  async request(command: string): Promise<unknown> {
    this.requests.push(command)
    const override = this.requestOverride?.(command)
    if (override) {
      return override
    }
    if (command === 'get_state') {
      return state
    }
    if (command === 'get_available_models') {
      return { models: [state.model] }
    }
    if (command === 'get_commands') {
      return { commands: [{ name: 'help' }] }
    }
    if (command === 'set_thinking_level') {
      throw new JsonlRpcResponseError(command, 'saved effort unavailable')
    }
    return {}
  }
  async send(frame: JsonlRpcRecord): Promise<void> {
    this.sent.push(frame)
  }
  async close(): Promise<Awaited<ReturnType<PiRpcConnection['close']>>> {
    this.abortRequest?.()
    this.closed = true
    this.rootVerdict = this.closeResult.root
    this.lastCloseResult = this.closeResult
    if (this.closeResult.root === 'exited' && !this.deferExit) {
      this.exit(this.closeError)
    }
    return this.closeResult
  }
  pauseReading(): void {}
  resumeReading(): void {}
  onExit(listener: () => void): void {
    if (this.rootVerdict === 'exited') {
      listener()
    } else {
      this.exitListeners.push(listener)
    }
  }
  receive(frame: JsonlRpcRecord): void {
    this.handlers.onRecord?.(frame)
  }
  exit(error = new Error('child exited')): void {
    this.closed = true
    this.rootVerdict = 'exited'
    for (const listener of this.exitListeners.splice(0)) {
      listener()
    }
    this.handlers.onExit?.(error, {
      expected: false,
      exit: { code: 1, signal: null, processless: false }
    })
  }
}

type PiLifecycleEvent = Parameters<PiRpcSessionAdapterDeps['onLifecycle']>[0]

/** The first `type` event the adapter reported; a missing one fails the test. */
export function reportedEvent<T extends PiLifecycleEvent['type']>(
  lifecycle: Mock<PiRpcSessionAdapterDeps['onLifecycle']>,
  type: T
): Extract<PiLifecycleEvent, { type: T }> {
  const isType = (event: PiLifecycleEvent): event is Extract<PiLifecycleEvent, { type: T }> =>
    event.type === type
  const found = lifecycle.mock.calls.map(([event]) => event).find(isType)
  if (!found) {
    throw new Error(`no ${type} event was reported`)
  }
  return found
}

export async function setup(
  options: Readonly<Record<string, string>> = {},
  eventSink?: (sink: StructuredAgentSessionEventSink) => StructuredAgentSessionEventSink
) {
  const rig = await openProviderTimelineRig({ agent: 'pi', sessionId })
  const connections: FakeConnection[] = []
  const lifecycle = vi.fn<PiRpcSessionAdapterDeps['onLifecycle']>()
  const settled = vi.fn<PiRpcSessionAdapterDeps['onSettled']>()
  const idle = vi.fn<PiRpcSessionAdapterDeps['onIdle']>()
  const onSpawned = vi.fn(async (_process: AgentSessionProcessIdentity) => {
    expect(connections.at(-1)?.requests).toEqual([])
  })
  const input: StructuredAgentSessionAcquireInput = {
    identity: {
      sessionId,
      workspaceId: 'folder-1',
      hostId: 'local',
      agent: 'pi',
      providerHandle: null
    },
    fence: 7,
    spawnToken: 'spawn-token',
    options,
    events: eventSink?.(rig.eventSink) ?? rig.eventSink,
    onSpawned
  }
  const resolveLaunch = vi.fn(async (): Promise<PiRpcResolvedLaunch> => ({
    command: '/host/bin/pi',
    cwd: '/host/folder',
    fullAccess: true,
    previous: null
  }))
  const openConnection = vi.fn(
    (_launch: ProviderProcessLaunch, handlers: JsonlRpcAgentConnectionOptions) => {
      const connection = new FakeConnection(handlers)
      connections.push(connection)
      return connection
    }
  )
  const adapter = new PiRpcSessionAdapter({
    resolveLaunch,
    readProcessStartTime: async () => 12345,
    openConnection,
    onLifecycle: lifecycle,
    onSettled: settled,
    onIdle: idle,
    logger: { warn: vi.fn(), error: vi.fn() }
  })
  const acquired = await adapter.acquire(input)
  // Commands are read after the start; waiting for them leaves nothing of it in flight.
  await vi.waitFor(() => expect(adapter.readCommands(sessionId)).toBeDefined())
  const started = reportedEvent(lifecycle, 'started')
  lifecycle.mockClear()
  const connection = connections[0]
  if (!connection) {
    throw new Error('connection missing')
  }
  cleanups.push(async () => {
    await adapter.closeAll().catch(() => {})
    await adapter.drainObservedExits()
    adapter.acknowledgeSessionRelease(sessionId)
  })
  return {
    adapter,
    connection,
    rig,
    acquired,
    started,
    onSpawned,
    lifecycle,
    settled,
    idle,
    input,
    resolveLaunch,
    openConnection,
    connections
  }
}

export async function restart(
  h: Awaited<ReturnType<typeof setup>>,
  configure: (connection: FakeConnection) => void,
  input: Partial<StructuredAgentSessionAcquireInput> = {}
) {
  await h.adapter.closeSession(sessionId)
  await h.adapter.drainObservedExits()
  h.lifecycle.mockClear()
  h.openConnection.mockImplementationOnce((_launch, handlers) => {
    const connection = new FakeConnection(handlers)
    configure(connection)
    h.connections.push(connection)
    return connection
  })
  const acquired = await h.adapter.acquire({ ...h.input, fence: 8, ...input })
  const child = h.connections.at(-1)
  if (!child) {
    throw new Error('child missing')
  }
  return { acquired, child }
}
