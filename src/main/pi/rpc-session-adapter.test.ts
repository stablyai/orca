import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { agentJournalTurnBody } from '../../shared/agent-session-turn-record'
import {
  AgentSessionAcquisitionRootExitObservedError,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
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
import { agentSessionLaunchFolderMissing } from '../runtime/agent-session-launch-directory'
import { PiRpcSessionAdapter } from './rpc-session-adapter'

const sessionId = 'session-timeline'
const file = '/host/account/sessions/session.jsonl'
const state = {
  sessionFile: file,
  isStreaming: false,
  isCompacting: false,
  model: { provider: 'anthropic', id: 'model-1' }
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  await closeProviderTimelineRigs()
})

class FakeConnection implements PiRpcConnection {
  pid = 4123
  closed = false
  rootVerdict: 'live' | 'unverifiable' | 'exited' = 'live'
  processless = false
  deferExit = false
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
      throw new Error('saved effort unavailable')
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
      this.exit()
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

async function setup(
  options: Readonly<Record<string, string>> = {},
  eventSink?: (sink: StructuredAgentSessionEventSink) => StructuredAgentSessionEventSink
) {
  const rig = await openProviderTimelineRig({ agent: 'pi', sessionId })
  const connections: FakeConnection[] = []
  const lifecycle = vi.fn(),
    settled = vi.fn(),
    idle = vi.fn()
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
  const resolveLaunch = vi.fn(async () => ({
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

describe('Pi RPC session ownership and delivery', () => {
  it('refuses a floating chat whose folder is gone with the reason the person reads', async () => {
    const h = await setup()
    await h.adapter.closeSession(sessionId)
    h.resolveLaunch.mockRejectedValueOnce(agentSessionLaunchFolderMissing('/gone/floating'))
    await expect(h.adapter.acquire({ ...h.input, fence: 8 })).rejects.toMatchObject({
      name: 'AgentSessionPreSpawnError',
      reason: 'launchFolderMissing'
    })
    expect(h.connections).toHaveLength(1)
  })

  it('does not spawn a start cancelled while resolving its workspace', async () => {
    const h = await setup()
    await h.adapter.closeSession(sessionId)
    const launch = await h.resolveLaunch.mock.results[0]?.value
    const resolving = Promise.withResolvers<NonNullable<typeof launch>>()
    h.resolveLaunch.mockImplementationOnce(() => resolving.promise)
    const controller = new AbortController()
    const started = h.adapter.acquire({ ...h.input, fence: 8, signal: controller.signal })
    await Promise.resolve()
    controller.abort(new Error('Pi closed while starting'))
    await expect(started).rejects.toThrow('closed while starting')
    expect(h.connections).toHaveLength(1)
    await expect(h.adapter.acquire({ ...h.input, fence: 9 })).resolves.toMatchObject({
      link: { origin: 'created' }
    })
    resolving.resolve(launch!)
    await Promise.resolve()
    expect(h.connections).toHaveLength(2)
  })

  it('kills the child and rejects a stalled startup when the host aborts it', async () => {
    const h = await setup()
    await h.adapter.closeSession(sessionId)
    const controller = new AbortController()
    const opened = Promise.withResolvers<FakeConnection>()
    const reply = Promise.withResolvers<unknown>()
    h.openConnection.mockImplementationOnce((_launch, handlers) => {
      const connection = new FakeConnection(handlers)
      connection.requestOverride = (command) =>
        command === 'get_state' ? reply.promise : undefined
      connection.abortRequest = () => reply.reject(new Error('closed while starting'))
      h.connections.push(connection)
      opened.resolve(connection)
      return connection
    })
    const started = h.adapter.acquire({ ...h.input, fence: 8, signal: controller.signal })
    const child = await opened.promise
    await Promise.resolve()
    controller.abort(new Error('Pi closed while starting'))
    await expect(started).rejects.toThrow('closed while starting')
    expect(child.rootVerdict).toBe('exited')
  })

  it('retains final events when exit publication times out under journal backpressure', async () => {
    let blocked = true
    const h = await setup({}, (sink) => ({
      ...sink,
      tryAppendTransition: (transition) =>
        blocked
          ? { accepted: false, reason: 'backpressure' }
          : sink.tryAppendTransition!(transition)
    }))
    vi.useFakeTimers()
    h.connection.receive({
      type: 'extension_ui_request',
      id: 'last-dialog',
      method: 'input',
      title: 'Final tail'
    })
    h.connection.exit()
    await vi.advanceTimersByTimeAsync(2_001)
    expect(h.lifecycle).toHaveBeenCalledOnce()
    h.adapter.acknowledgeSessionRelease(sessionId)
    let completed = false
    const drained = h.adapter.drainObservedExits().then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    blocked = false
    await vi.advanceTimersByTimeAsync(250)
    await drained
    expect(
      (await h.rig.rows()).some(
        (row) => row.body.kind === 'question' && row.body.question === 'Final tail'
      )
    ).toBe(true)
    vi.useRealTimers()
  })
  it('lets a new acquisition proceed while the released child drains final stdout', async () => {
    const h = await setup()
    h.connection.deferExit = true
    await h.adapter.closeSession(sessionId)
    h.adapter.acknowledgeSessionRelease(sessionId)
    await expect(h.adapter.acquire({ ...h.input, fence: 8 })).resolves.toMatchObject({
      link: { origin: 'created' }
    })
    let drained = false
    const delivery = h.adapter.drainObservedExits().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    h.connection.exit()
    await delivery
    expect(h.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ fence: 7, cause: 'requested-close' })
    )
  })

  it('preserves an unexpected failure cause during forced cleanup', async () => {
    const h = await setup()
    await h.adapter.forceCloseSession(sessionId)
    await h.adapter.drainObservedExits()
    expect(h.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'unexpected-exit', reason: 'Pi event sink failed' })
    )
  })
  it('records the spawned child before the first startup RPC and links the native file', async () => {
    const h = await setup({ effort: 'high', unknown: 'old-value' })
    expect(h.onSpawned).toHaveBeenCalledWith({
      hostId: 'local',
      pid: 4123,
      processStartTimeMs: 12345,
      spawnToken: 'spawn-token'
    })
    expect(h.acquired.process).toEqual(h.onSpawned.mock.calls[0]?.[0])
    expect(h.acquired.link).toMatchObject({
      handle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: file },
      origin: 'created',
      mintedAtFence: 7
    })
    expect(h.adapter.readOptionRestoreFailures(sessionId)).toEqual(['effort', 'unknown'])
    expect(h.connection.requests).toContain('get_commands')
  })

  it('admits a send before Pi confirms it and settles only after journal acceptance', async () => {
    const h = await setup()
    const result = await h.adapter.dispatch({
      sessionId,
      fence: 7,
      clientMessageId: 'send-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
    })
    expect(result).toEqual({ state: 'admitted' })
    expect(h.settled).not.toHaveBeenCalled()
    h.connection.receive({ type: 'agent_start' })
    expect(h.settled).toHaveBeenCalledWith({
      sessionId,
      clientMessageId: 'send-1',
      fence: 7,
      outcome: {
        state: 'accepted',
        providerIdentity: { provider: 'orca', clientMessageId: 'send-1' }
      }
    })
    expect(h.connection.sent[0]).toMatchObject({ type: 'prompt', message: 'hello' })
  })

  it('rejects stale fences and a Stop for a different turn before sending abort', async () => {
    const h = await setup()
    await expect(
      h.adapter.dispatch({
        sessionId,
        fence: 6,
        clientMessageId: 'stale',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'x' }] }
      })
    ).rejects.toThrow('not live under this fence')
    await h.adapter.dispatch({
      sessionId,
      fence: 7,
      clientMessageId: 'send-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'x' }] }
    })
    h.connection.receive({ type: 'agent_start' })
    expect(
      await h.adapter.cancelTurn({
        sessionId,
        fence: 7,
        turnId: 'other',
        resolveLiveTurnId: () => h.rig.assembler.openTurnId
      })
    ).toEqual({ cancelled: false })
    expect(h.connection.requests).not.toContain('abort')
    expect((await h.adapter.cancelTurn({ sessionId, fence: 7 })).cancelled).toBe(true)
    expect(h.connection.requests).toContain('abort')
    expect(await h.adapter.closeSession(sessionId)).toBe(true)
    expect(h.connection.closed).toBe(true)
  })

  it('keeps a pending manual compaction cancellable and reports root/tree proof honestly', async () => {
    const h = await setup()
    const turnId = 'manual-compact'
    const command = {
      clientMessageId: 'compact-1',
      turnId,
      identity: { provider: 'orca' as const, clientMessageId: 'compact-1' },
      resultIdentity: { provider: 'orca' as const, clientMessageId: 'compact-result' },
      running: { kind: 'turn' as const, turnId, state: 'running' as const }
    }
    let release: (() => void) | undefined
    h.connection.requestOverride = (name) =>
      name === 'compact'
        ? new Promise<void>((resolve) => {
            release = resolve
          })
        : undefined
    const compact = h.adapter.compact({ sessionId, fence: 7, command })
    expect((await h.adapter.cancelTurn({ sessionId, fence: 7 })).cancelled).toBe(true)
    expect(h.connection.requests).toContain('abort')
    release?.()
    await compact
    h.connection.closeResult = { root: 'exited', tree: 'unverifiable' }
    await expect(h.adapter.closeSession(sessionId)).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )
  })

  it('ends the host command row under its original identity after a no-op compaction', async () => {
    const h = await setup()
    const command = {
      clientMessageId: 'compact-1',
      turnId: 'manual-compact',
      identity: { provider: 'orca' as const, clientMessageId: 'compact-turn' },
      resultIdentity: { provider: 'orca' as const, clientMessageId: 'compact-result' },
      running: { kind: 'turn' as const, turnId: 'manual-compact', state: 'running' as const }
    }
    h.rig.journal.appendItem(command.identity, agentJournalTurnBody(command.running), {
      fence: 1,
      turnScope: { kind: 'thread' }
    })
    h.connection.requestOverride = (name) =>
      name === 'compact'
        ? Promise.reject(new JsonlRpcResponseError(name, 'Nothing to compact (session too small)'))
        : undefined
    expect(await h.adapter.compact({ sessionId, fence: 7, command })).toEqual({
      state: 'accepted',
      providerIdentity: null
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(
      (await h.rig.rows()).find((row) => row.itemId === agentJournalItemKey(command.identity))?.body
    ).toMatchObject({ kind: 'turn', state: 'completed', outcome: 'success' })
    expect(
      (await h.rig.rows()).some((row) => row.body.kind === 'status' && row.body.tone === 'warning')
    ).toBe(true)
  })

  it('answers a live dialog once after commit and does not claim it after dismissal', async () => {
    const h = await setup()
    h.connection.receive({
      type: 'extension_ui_request',
      id: 'input-1',
      method: 'editor',
      title: 'Edit',
      prefill: 'draft'
    })
    const row = (await h.rig.rows()).find((item) => item.body.kind === 'question')
    expect(row?.body).toMatchObject({
      kind: 'question',
      freeTextInput: { allowEmpty: true, initialValue: 'draft' }
    })
    if (!row) {
      throw new Error('dialog row missing')
    }
    let release: (() => void) | undefined
    const commit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const response = {
      kind: 'answers' as const,
      answers: [{ questionId: 'input-1', optionIds: [], other: '' }]
    }
    const first = h.adapter.answerPrompt({
      sessionId,
      fence: 7,
      itemId: row.itemId,
      kind: 'question',
      response,
      commit
    })
    await expect(
      h.adapter.answerPrompt({
        sessionId,
        fence: 7,
        itemId: row.itemId,
        kind: 'question',
        response,
        commit: vi.fn()
      })
    ).rejects.toThrow('no longer waiting')
    release?.()
    await first
    expect(commit).toHaveBeenCalledTimes(1)
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'input-1',
      value: ''
    })
    await expect(
      h.adapter.dismissPrompt({
        sessionId,
        fence: 7,
        itemId: row.itemId,
        answer: true,
        commit: vi.fn()
      })
    ).rejects.toThrow('no longer waiting')
  })

  it('releases a failed dialog commit for a later dismissal, with one provider reply', async () => {
    const h = await setup()
    h.connection.receive({
      type: 'extension_ui_request',
      id: 2,
      method: 'confirm',
      title: 'Continue?'
    })
    const row = (await h.rig.rows()).find((item) => item.body.kind === 'approval')
    if (!row) {
      throw new Error('approval row missing')
    }
    await expect(
      h.adapter.answerPrompt({
        sessionId,
        fence: 7,
        itemId: row.itemId,
        kind: 'approval',
        response: { kind: 'option', optionId: 'yes' },
        commit: async () => {
          throw new Error('CAS lost')
        }
      })
    ).rejects.toThrow('CAS lost')
    expect(h.connection.sent).toEqual([])
    let release: (() => void) | undefined
    const dismiss = h.adapter.dismissPrompt({
      sessionId,
      fence: 7,
      itemId: row.itemId,
      answer: true,
      commit: () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    })
    await expect(
      h.adapter.answerPrompt({
        sessionId,
        fence: 7,
        itemId: row.itemId,
        kind: 'approval',
        response: { kind: 'option', optionId: 'no' },
        commit: vi.fn()
      })
    ).rejects.toThrow('no longer waiting')
    release?.()
    await dismiss
    expect(h.connection.sent).toEqual([{ type: 'extension_ui_response', id: 2, cancelled: true }])
  })

  it('reports unexpected child exit once and preserves an unproven root on close', async () => {
    const h = await setup()
    h.connection.exit(new Error('provider died'))
    await h.adapter.drainObservedExits()
    h.connection.exit(new Error('duplicate exit'))
    await h.adapter.drainObservedExits()
    expect(h.lifecycle).toHaveBeenCalledTimes(1)
    expect(h.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ended',
        sessionId,
        fence: 7,
        acquisitionGeneration: h.acquired.acquisitionGeneration,
        cause: 'unexpected-exit',
        reason: 'provider died'
      })
    )

    const other = await setup()
    other.connection.closeResult = { root: 'unverifiable', tree: null }
    expect(await other.adapter.closeSession(sessionId)).toBe(false)
  })
})

describe('Pi RPC start without a model', () => {
  it('reports a start that listed no model as signed out, for that child only', async () => {
    const h = await setup()
    expect(h.adapter.startUnavailable(sessionId)).toBeUndefined()
    await h.adapter.closeSession(sessionId)
    h.openConnection.mockImplementationOnce((_launch, handlers) => {
      const connection = new FakeConnection(handlers)
      // What a signed-out Pi lists (captured from Pi 1.0.4 in __fixtures__/signed-out.jsonl).
      connection.requestOverride = (command) =>
        command === 'get_available_models' ? Promise.resolve({ models: [] }) : undefined
      h.connections.push(connection)
      return connection
    })
    await h.adapter.acquire({ ...h.input, fence: 8 })
    expect(h.adapter.startUnavailable(sessionId)).toEqual({ reason: 'notSignedIn' })
    // Its root gone while its output still drains: that child says nothing more.
    const child = h.connections.at(-1)!
    child.rootVerdict = 'exited'
    expect(child.closed).toBe(false)
    expect(h.adapter.startUnavailable(sessionId)).toBeUndefined()
    child.rootVerdict = 'live'
    await h.adapter.closeSession(sessionId)
    expect(h.adapter.startUnavailable(sessionId)).toBeUndefined()
  })
})
