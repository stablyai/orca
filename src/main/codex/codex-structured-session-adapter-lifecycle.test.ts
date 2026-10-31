import {
  checkpointJournalRig,
  closeCheckpointTestJournals
} from '../claude/claude-checkpoint-test-support'
import { StructuredAgentSessionExitObservation } from '../native-chat/agent-session-wire/structured-agent-session-exit-observation'
import { acquireReadyCodexForTest } from './codex-structured-session-adapter-fixture'
import { describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from './app-server/codex-app-server-connection-types'
import type {
  CodexAppServerLaunch,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredLaunch,
  type CodexStructuredSessionEvent
} from './codex-structured-session-adapter'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

const THREAD_ID = 'thread-abc'

function identityFor(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: codexProviderHandle(THREAD_ID)
  }
}

const USER_MESSAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ship it' }]
}

type PlanNotificationFixtureParams =
  | { turn: { id: string } }
  | { item: { type: 'plan'; id: string; text: string } }
  | { itemId: string; delta: string }
  | { turnId: string; item: { type: 'userMessage'; id: string; clientId: string } }

type Route = (params: Record<string, unknown> | undefined) => unknown

type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  launch: CodexAppServerLaunch
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown; code?: number; message?: string }[]
  closeCount: number
  readingPaused: boolean
}

function fakeCodex(routes: Record<string, Route> = {}): {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
  routes: Record<string, Route>
} {
  const connections: FakeConnection[] = []
  const openConnection: typeof openCodexAppServerConnection = async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      replies: [],
      closeCount: 0,
      readingPaused: false,
      pauseReading: () => {
        connection.readingPaused = true
      },
      resumeReading: () => {
        connection.readingPaused = false
      },
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        connection.calls.push({ method, params })
        const route = routes[method]
        return route ? route(params) : {}
      },
      notify: () => {},
      respond: (id, result) => connection.replies.push({ id, result }),
      respondWithError: (id, code, message) => connection.replies.push({ id, code, message }),
      close: async () => {
        connection.closeCount += 1
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }
  routes['thread/start'] ??= () => ({
    thread: { id: THREAD_ID, path: '/rollouts/abc.jsonl' },
    model: 'gpt-live',
    reasoningEffort: 'medium'
  })
  routes['thread/resume'] ??= (params) => ({
    thread: { id: (params as { threadId: string }).threadId },
    model: 'gpt-live',
    reasoningEffort: 'medium'
  })
  return { connections, openConnection, routes }
}

function adapterFor(
  codex: ReturnType<typeof fakeCodex>,
  launch: Partial<CodexStructuredLaunch> = {},
  events: CodexStructuredSessionEvent[] = []
): CodexStructuredSessionAdapter {
  let acquisitionGeneration = 0
  return new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null,
      ...launch
    }),
    onEvent: (event) => events.push(event),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    mintAcquisitionGeneration: () => `generation-${++acquisitionGeneration}`
  })
}

async function acquired(
  codex: ReturnType<typeof fakeCodex>,
  launch: Partial<CodexStructuredLaunch> = {},
  events: CodexStructuredSessionEvent[] = []
): Promise<CodexStructuredSessionAdapter> {
  const adapter = adapterFor(codex, launch, events)
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9'
  })
  return adapter
}

describe('CodexStructuredSessionAdapter lifecycle', () => {
  it('keeps sessions isolated and closes each child once', async () => {
    const codex = fakeCodex()
    const adapter = adapterFor(codex)
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 1,
      spawnToken: 'spawn-a'
    })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-2'),
      fence: 1,
      spawnToken: 'spawn-b'
    })

    codex.connections[0].handlers.onServerRequest?.({
      id: 21,
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'codex-item-1', threadId: THREAD_ID, turnId: 'turn-1' }
    })
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-2',
        itemId: 'codex-item-1',
        kind: 'approval',
        response: { kind: 'option', optionId: 'accept' },
        fence: 1,
        commit: async () => undefined
      })
    ).rejects.toThrow('no longer waiting on')

    await adapter.closeAll()
    expect(codex.connections.map((connection) => connection.closeCount)).toEqual([1, 1])
    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 1 })
    ).rejects.toThrow('no live codex app-server for session session-1')
  })

  it('retains ownership until a child exit is proven and reports it once', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const adapter = await acquired(codex, {}, events)

    const connection = codex.connections[0]
    connection.close = async () => {
      connection.closeCount += 1
      return false
    }
    connection.handlers.onExit?.(new Error('codex app-server connection ended'))

    expect(events.at(-1)).toEqual({
      type: 'ended',
      sessionId: 'session-1',
      reason: 'codex app-server connection ended',
      failure: { kind: 'providerExited' },
      cause: 'unexpected-exit',
      fence: 7,
      acquisitionGeneration: 'generation-1',
      observedAt: expect.any(Number)
    })
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).rejects.toThrow('no live codex app-server')
    expect(adapter.backgroundTaskStops('session-1')).toBeDefined()
    await expect(adapter.closeSession('session-1')).resolves.toBe(false)
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
  })

  it('keeps the live session when a child it already replaced dies', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const adapter = await acquired(codex, {}, events)
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 8,
      spawnToken: 'spawn-10'
    })
    const endedBeforeStaleExit = events.filter((event) => event.type === 'ended').length

    codex.connections[0].handlers.onExit?.(new Error('the superseded child died'))

    expect(events.filter((event) => event.type === 'ended')).toHaveLength(endedBeforeStaleExit)
    expect(adapter.backgroundTaskStops('session-1')).toBeDefined()
  })

  it('times turn and item boundaries at receipt, and nothing else', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    await acquired(codex, {}, events)
    const connection = codex.connections[0]
    const item = { type: 'reasoning', id: 'r-1', summary: [], content: [] }
    connection.handlers.onNotification?.('item/started', { threadId: THREAD_ID, item })
    connection.handlers.onNotification?.('item/reasoning/summaryTextDelta', {
      threadId: THREAD_ID,
      itemId: 'r-1',
      delta: 'Planning'
    })
    connection.handlers.onNotification?.('item/completed', { threadId: THREAD_ID, item })
    const timed = events.flatMap((event) =>
      event.type === 'notification' ? [[event.method, event.observedAt]] : []
    )
    expect(timed).toEqual([
      ['item/started', 1_700_000_000_500],
      ['item/reasoning/summaryTextDelta', undefined],
      ['item/completed', 1_700_000_000_500]
    ])
  })

  it('ignores Codex traffic that arrives after the session is gone', async () => {
    const codex = fakeCodex()
    const adapter = await acquired(codex)
    const connection = codex.connections[0]

    await adapter.closeSession('session-1')
    connection.handlers.onNotification?.('item/agentMessage/delta', { delta: 'x' })
    connection.handlers.onServerRequest?.({
      id: 31,
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'codex-item-9', threadId: THREAD_ID }
    })

    expect(connection.replies).toEqual([])
  })

  it('flushes the final coalesced text before a graceful close', async () => {
    const codex = fakeCodex()
    const bodies: AgentJournalMessageItem[] = []
    const lifecycles: unknown[] = []
    const tombstones: unknown[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (identity, body) => {
        if (body.kind === 'message') {
          bodies.push(body)
        } else if (readAgentJournalTurn(body)) {
          lifecycles.push({ identity, turnLifecycle: readAgentJournalTurn(body) })
        }
      },
      appendTombstone: (identity) => {
        tombstones.push(identity)
      },
      publish: () => {}
    }
    const adapter = adapterFor(codex)
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })
    const notify = codex.connections[0]!.handlers.onNotification
    notify?.('turn/started', { threadId: THREAD_ID, turn: { id: 'turn-1' } })
    notify?.('item/started', {
      threadId: THREAD_ID,
      item: { type: 'agentMessage', id: 'item-1', text: '' }
    })
    notify?.('item/agentMessage/delta', {
      threadId: THREAD_ID,
      itemId: 'item-1',
      delta: 'last words'
    })

    await adapter.closeSession('session-1')

    expect(bodies.at(-1)?.blocks).toEqual([{ type: 'text', text: 'last words' }])
    expect(tombstones).toEqual([])
    expect(lifecycles.at(-1)).toEqual({
      identity: {
        provider: 'legacy',
        agent: 'codex',
        sessionId: 'session-1',
        recordId: 'turn-lifecycle:turn-1'
      },
      turnLifecycle: {
        turnId: 'turn-1',
        state: 'interrupted',
        userItemId: `codex:${THREAD_ID}:turn-1:0`,
        startedAt: expect.any(Number),
        completedAt: expect.any(Number)
      }
    })
  })
})

describe('acquired scheduled plan delivery', () => {
  it.each(
    (['failed', 'closed'] as const).flatMap((reason) =>
      (['append', 'publication'] as const).map((boundary) => ({ reason, boundary }))
    )
  )(
    'routes original scheduled $reason at $boundary through current owner once, retaining full text until actual end',
    async ({ reason, boundary }) => {
      vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
      const codex = fakeCodex({ 'turn/start': () => ({ turn: { id: 'turn' } }) })
      const events: CodexStructuredSessionEvent[] = []
      const adapter = adapterFor(codex, {}, events)
      const bodies: unknown[] = []
      const exit = new StructuredAgentSessionExitObservation()
      let refuse = false
      const sink: StructuredAgentSessionEventSink = {
        observeExit: exit.record,
        appendItem: (_identity, body) => {
          bodies.push(body)
        },
        appendTombstone: () => {},
        publish: () => {},
        tryAppendItem: (identity, body, options) => {
          if (refuse && boundary === 'append') {
            return { accepted: false, reason }
          }
          sink.appendItem(identity, body, options)
          return { accepted: true }
        },
        tryPublish: () =>
          refuse && boundary === 'publication' ? { accepted: false, reason } : { accepted: true }
      }
      try {
        await acquireReadyCodexForTest(adapter, {
          identity: identityFor('session-1'),
          fence: 7,
          spawnToken: 'spawn-9',
          events: sink
        })
        await expect(
          adapter.dispatch({
            sessionId: 'session-1',
            clientMessageId: 'pending-send',
            fence: 7,
            body: USER_MESSAGE
          })
        ).resolves.toMatchObject({ state: 'admitted' })
        expect(adapter.heldSends('session-1')?.has('pending-send')).toBe(true)
        const connection = codex.connections[0]
        connection.close = async () => {
          connection.closeCount++
          return false
        }
        const notify = (method: string, params: PlanNotificationFixtureParams) =>
          connection.handlers.onNotification?.(method, { threadId: THREAD_ID, ...params })
        notify('turn/started', { turn: { id: 'turn' } })
        notify('item/started', { item: { type: 'plan', id: 'plan', text: '' } })
        notify('item/plan/delta', { itemId: 'plan', delta: 'P' })
        vi.advanceTimersByTime(60)
        notify('item/plan/delta', { itemId: 'plan', delta: 'T' })
        vi.advanceTimersByTime(60)
        refuse = true
        await vi.advanceTimersByTimeAsync(340)
        expect(connection.closeCount).toBe(1)
        expect(events.filter((event) => event.type === 'ended')).toHaveLength(0)
        await vi.advanceTimersByTimeAsync(1000)
        expect(connection.closeCount).toBe(1)
        expect(vi.getTimerCount()).toBe(0)
        refuse = false
        connection.closed = true
        connection.handlers.onExit?.(new Error('actual exit'), { expected: true })
        expect(bodies).toContainEqual({ kind: 'status', presentation: 'plan-document', text: 'PT' })
        expect(events.filter((event) => event.type === 'ended')).toMatchObject([
          {
            reason: `scheduled plan admission failed (${reason})`,
            cause: 'unexpected-exit',
            fence: 7,
            acquisitionGeneration: 'generation-1'
          }
        ])
        expect(exit.heldSends).toEqual(new Set(['pending-send']))
        expect(adapter.heldSends('session-1')?.size).toBe(0)
        const count = bodies.length
        await vi.advanceTimersByTimeAsync(1000)
        expect(bodies).toHaveLength(count)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        await adapter.closeAll()
        vi.useRealTimers()
      }
    }
  )

  it('buffers a first plan before publication, then handles first-window failure under the installed owner', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const adapter = adapterFor(codex, {}, events)
    let refuse = true
    const attempted: unknown[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {},
      tryAppendItem: (_identity, body) => {
        attempted.push(body)
        return refuse ? { accepted: false, reason: 'closed' } : { accepted: true }
      }
    }
    try {
      const acquisition = await adapter.acquire({
        identity: identityFor('session-1'),
        fence: 7,
        spawnToken: 'spawn-9',
        events: sink
      })
      const connection = codex.connections[0]
      connection.handlers.onNotification?.('item/plan/delta', {
        threadId: THREAD_ID,
        itemId: 'plan',
        delta: 'buffered'
      })
      vi.advanceTimersByTime(1000)
      expect(attempted).toEqual([])
      expect(connection.closeCount).toBe(0)
      await adapter.open({
        sessionId: 'session-1',
        fence: 7,
        acquisitionGeneration: acquisition.acquisitionGeneration,
        signal: new AbortController().signal
      })
      await vi.advanceTimersByTimeAsync(60)
      expect(connection.closeCount).toBe(1)
      expect(attempted).toContainEqual({
        kind: 'status',
        presentation: 'plan-document',
        text: 'buffered'
      })
      expect(events.filter((event) => event.type === 'ended')).toMatchObject([
        { reason: 'scheduled plan admission failed (closed)' }
      ])
      refuse = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(connection.closeCount).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await adapter.closeAll()
      vi.useRealTimers()
    }
  })

  it('retires an old owed wake when a replacement is installed and does not close the new owner', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const codex = fakeCodex()
    const adapter = adapterFor(codex)
    const sink: StructuredAgentSessionEventSink = {
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {}
    }
    try {
      await acquireReadyCodexForTest(adapter, {
        identity: identityFor('session-1'),
        fence: 7,
        spawnToken: 'spawn-9',
        events: sink
      })
      const timers = vi.spyOn(globalThis, 'setTimeout')
      const old = codex.connections[0]
      old.handlers.onNotification?.('item/plan/delta', {
        threadId: THREAD_ID,
        itemId: 'plan',
        delta: 'P'
      })
      vi.advanceTimersByTime(60)
      old.handlers.onNotification?.('item/plan/delta', {
        threadId: THREAD_ID,
        itemId: 'plan',
        delta: 'T'
      })
      vi.advanceTimersByTime(60)
      const staleWake = timers.mock.calls.find(([, ms]) => ms === 340)?.[0]
      expect(typeof staleWake).toBe('function')
      await acquireReadyCodexForTest(adapter, {
        identity: identityFor('session-1'),
        fence: 8,
        spawnToken: 'spawn-10',
        events: sink
      })
      sink.tryAppendItem = () => ({ accepted: false, reason: 'failed' })
      if (typeof staleWake === 'function') {
        staleWake()
      }
      timers.mockRestore()
      await vi.advanceTimersByTimeAsync(1000)
      expect(codex.connections.map((connection) => connection.closeCount)).toEqual([1, 0])
      expect(adapter.backgroundTaskStops('session-1')).toBeDefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await adapter.closeAll()
      vi.useRealTimers()
    }
  })
})

it('retries an acquired plan after native drain without a notification head, then settles its real dispatched send', async () => {
  const r = await checkpointJournalRig({
    watermarks: { maxQueuedOperations: 2, lowQueuedOperations: 0, lowQueuedBytes: 0 }
  })
  r.translator.dispose()
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  const codex = fakeCodex({ 'turn/start': () => ({ turn: { id: 'turn' } }) })
  const adapter = adapterFor(codex)
  const gate = Promise.withResolvers<void>()
  try {
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: r.deferred.sink
    })
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'pending-send',
        fence: 7,
        body: USER_MESSAGE
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    const connection = codex.connections[0]
    const notify = (method: string, params: PlanNotificationFixtureParams) =>
      connection.handlers.onNotification?.(method, { threadId: THREAD_ID, ...params })
    notify('turn/started', { turn: { id: 'turn' } })
    await r.deferred.drained()
    notify('item/started', { item: { type: 'plan', id: 'plan', text: '' } })
    notify('item/plan/delta', { itemId: 'plan', delta: 'P' })
    await vi.advanceTimersByTimeAsync(60)
    await r.deferred.drained()
    const plan = () =>
      r.journal
        .snapshot()
        .items.find(
          (item) => item.body.kind === 'status' && item.body.presentation === 'plan-document'
        )
    const first = plan()
    expect(first?.body).toMatchObject({ text: 'P' })
    await vi.advanceTimersByTimeAsync(40)
    notify('item/plan/delta', { itemId: 'plan', delta: 'T' })
    await vi.advanceTimersByTimeAsync(60)
    await r.journal.readInOrder(() => {
      void r.journal.readInOrder(() => gate.promise)
    })
    for (const uuid of ['block-1', 'block-2']) {
      expect(
        r.deferred.sink.tryAppendItem?.(
          { provider: 'claude', sessionId: 'block', uuid },
          { kind: 'status', text: uuid },
          { turnScope: { kind: 'thread' } }
        )
      ).toEqual({ accepted: true })
    }
    await vi.advanceTimersByTimeAsync(300)
    expect(connection.readingPaused).toBe(true)
    expect(plan()?.body).toMatchObject({ text: 'P' })
    expect(adapter.heldSends('session-1')).toEqual(new Set(['pending-send']))
    expect(connection.closeCount).toBe(0)
    gate.resolve()
    expect((await r.deferred.drained()).ok).toBe(true)
    expect(connection.readingPaused).toBe(false)
    await vi.advanceTimersByTimeAsync(60)
    expect((await r.deferred.drained()).ok).toBe(true)
    expect(plan()).toMatchObject({
      sequence: first?.sequence,
      observedAt: first?.observedAt,
      turnScope: first?.turnScope,
      body: { text: 'PT' }
    })
    expect(adapter.heldSends('session-1')).toEqual(new Set(['pending-send']))
    expect(vi.getTimerCount()).toBe(0)
    // The real echo arrives only after reads resumed and the autonomous full tail was proven.
    notify('item/completed', {
      turnId: 'turn',
      item: { type: 'userMessage', id: 'echo', clientId: 'pending-send' }
    })
    await r.deferred.drained()
    expect(adapter.heldSends('session-1')?.size).toBe(0)
    await adapter.closeAll()
    expect((await r.deferred.drained()).ok).toBe(true)
    const beforeReopen = r.journal.snapshot().items
    await r.journal.close()
    const reopened = await r.reopen()
    expect(reopened.snapshot().items).toEqual(beforeReopen)
    expect(
      reopened.snapshot().items.find((item) => item.itemId === first?.itemId)?.body
    ).toMatchObject({ text: 'PT' })
  } finally {
    gate.resolve()
    await adapter.closeAll()
    await closeCheckpointTestJournals()
    vi.useRealTimers()
  }
})
