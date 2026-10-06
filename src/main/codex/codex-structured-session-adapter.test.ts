import { describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerRequestError,
  type openCodexAppServerConnection
} from './codex-app-server-connection'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredLaunch,
  type CodexStructuredSessionEvent
} from './codex-structured-session-adapter'
import {
  THREAD_ID,
  USER_MESSAGE,
  acquired,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'

describe('CodexStructuredSessionAdapter.acquire', () => {
  it('keeps a started thread usable when its model listing never answers', async () => {
    const codex = fakeCodex({ 'model/list': () => new Promise<never>(() => {}) })
    const adapter = adapterFor(codex)

    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'gpt-saved', effort: 'low', fastMode: 'true' }
    })

    expect(adapter.readAcquisitionOptions({ sessionId: 'session-1', fence: 7 })).toEqual({
      model: 'gpt-saved',
      effort: 'low',
      fastMode: 'true'
    })
    expect(codex.connections[0].calls.map((call) => call.method)).toEqual([
      'thread/start',
      'model/list'
    ])
  })

  it('persists saved model and effort as the next turn uses them', async () => {
    const codex = fakeCodex()
    const adapter = adapterFor(codex)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'gpt-saved', effort: 'low', personality: 'concise' }
    })

    expect(
      adapter.readAcquisitionOptions({
        sessionId: 'session-1',
        fence: 7,
        priorOptions: { model: 'gpt-saved', effort: 'low', personality: 'concise' }
      })
    ).toEqual({ model: 'gpt-saved', effort: 'low', personality: 'concise' })
  })

  it('keeps a saved next-turn pick when resuming a thread that reports its previous pick', async () => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = () => ({ turn: { id: 'turn-1' } })
    const adapter = adapterFor(codex, { resumeThreadId: THREAD_ID })
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'gpt-next', effort: 'low' }
    })

    const saved = adapter.readAcquisitionOptions({ sessionId: 'session-1', fence: 7 })
    expect(saved).toMatchObject({ model: 'gpt-next', effort: 'low' })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'next-turn',
      body: USER_MESSAGE,
      fence: 7
    })
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({
      model: 'gpt-next',
      effort: 'low'
    })
    await adapter.closeSession('session-1')
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 8,
      spawnToken: 'spawn-10',
      options: saved
    })
    expect(adapter.readAcquisitionOptions({ sessionId: 'session-1', fence: 8 })).toMatchObject({
      model: 'gpt-next',
      effort: 'low'
    })
  })

  it('leaves a rejected listing as a catalog error after the thread opens', async () => {
    const codex = fakeCodex({
      'model/list': () => {
        throw new Error('stub model/list rejected')
      }
    })
    const adapter = adapterFor(codex)

    await adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })

    expect(adapter.readAcquisitionOptions({ sessionId: 'session-1', fence: 7 })).toEqual({
      model: 'gpt-live',
      effort: 'medium'
    })
    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).rejects.toThrow(
      'stub model/list rejected'
    )
    expect(codex.connections[0].closeCount).toBe(0)
  })

  it('starts a new thread and reports the process and link the lease will prove', async () => {
    const codex = fakeCodex()
    const adapter = adapterFor(codex, { codexHome: '/codex/home' })

    const acquisition = await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9'
    })

    expect(codex.connections[0].launch.env).toEqual({
      [CODEX_SPAWN_TOKEN_ENV]: 'spawn-9',
      CODEX_HOME: '/codex/home',
      ORCA_AGENT_SESSION_ID: 'session-1',
      ORCA_STRUCTURED_SESSION: '1',
      ORCA_CLI_COMMAND: expect.stringMatching(/^[^:;]*[\\/]cli[\\/]bin[\\/]orca-dev$/),
      ...(process.platform !== 'win32'
        ? { ORCA_CLI_BIN_DIR: expect.stringMatching(/^[^:;]*[\\/]cli[\\/]bin$/) }
        : {}),
      ORCA_USER_DATA_PATH: expect.any(String),
      // The test host is unpackaged, so this app's CLI is the dev launcher dir, first on PATH.
      PATH: expect.stringMatching(/^[^:;]*[\\/]cli[\\/]bin[:;]/)
    })
    expect(codex.connections[0].launch.cwd).toBe('/work/repo')
    expect(codex.connections[0].calls[0]).toEqual({
      method: 'thread/start',
      params: { cwd: '/work/repo' }
    })
    expect(acquisition.process).toEqual({
      hostId: 'host-1',
      pid: 4321,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: 'spawn-9'
    })
    expect(acquisition.link).toEqual({
      linkId: `codex-7-${THREAD_ID}`,
      handle: codexProviderHandle(THREAD_ID),
      origin: 'created',
      mintedAtFence: 7,
      observedAt: 1_700_000_000_500
    })
    expect(acquisition.acquisitionGeneration).toBe('generation-1')
  })

  // A thread opened on Codex's configured default and then given a turn on the chosen model
  // reads to Codex as a model switch, and it injects the chosen model's whole prompt again.
  it('opens the thread on the model the session chose, not on the configured default', async () => {
    const codex = fakeCodex()
    const adapter = adapterFor(codex, { model: 'gpt-chosen' })

    await adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })

    expect(codex.connections[0].calls[0]).toEqual({
      method: 'thread/start',
      params: { cwd: '/work/repo', model: 'gpt-chosen' }
    })
  })

  it('resumes the thread the durable handle chain names, not the client one', async () => {
    const codex = fakeCodex()
    const adapter = adapterFor(codex, {
      resumeThreadId: 'thread-proven',
      resumePath: '/rollouts/thread-proven.jsonl'
    })

    const acquisition = await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 9,
      spawnToken: 'spawn-9'
    })

    expect(codex.connections[0].calls[0]).toEqual({
      method: 'thread/resume',
      params: expect.objectContaining({
        threadId: 'thread-proven',
        cwd: '/work/repo',
        path: '/rollouts/thread-proven.jsonl'
      })
    })
    expect(acquisition.link.origin).toBe('resumed')
    expect(acquisition.link.handle).toEqual(codexProviderHandle('thread-proven'))
  })

  it('starts a thread in place of a creation Codex never saved, and says which it replaced', async () => {
    const codex = fakeCodex({
      'thread/resume': () => {
        throw new CodexAppServerRequestError(
          'thread/resume',
          -32600,
          'codex app-server thread/resume failed: no rollout found for thread id thread-unsaved'
        )
      }
    })
    const adapter = adapterFor(codex, {
      resumeThreadId: 'thread-unsaved',
      supersedeIfUnsaved: true
    })

    const acquisition = await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 9,
      spawnToken: 'spawn-9'
    })

    expect(codex.connections[0].calls.slice(0, 2).map((call) => call.method)).toEqual([
      'thread/resume',
      'thread/start'
    ])
    expect(acquisition.link).toEqual({
      linkId: `codex-9-${THREAD_ID}`,
      handle: codexProviderHandle(THREAD_ID),
      origin: 'created',
      supersedesKey: 'codex:"thread-unsaved"',
      mintedAtFence: 9,
      observedAt: 1_700_000_000_500
    })
    expect(codex.connections[0].closeCount).toBe(0)
  })

  it('refuses a resume that lands on a different thread and reaps the child', async () => {
    const codex = fakeCodex({ 'thread/resume': () => ({ thread: { id: 'thread-other' } }) })
    const adapter = adapterFor(codex, { resumeThreadId: 'thread-proven' })

    await expect(
      adapter.acquire({ identity: identityFor('session-1'), fence: 9, spawnToken: 'spawn-9' })
    ).rejects.toThrow('resumed thread-other instead of thread-proven')
    expect(codex.connections[0].closeCount).toBe(1)
  })

  it('refuses a thread Codex never named', async () => {
    const codex = fakeCodex({ 'thread/start': () => ({}) })
    const adapter = adapterFor(codex)

    await expect(
      adapter.acquire({ identity: identityFor('session-1'), fence: 1, spawnToken: 'spawn-9' })
    ).rejects.toThrow('did not name the thread')
    expect(codex.connections[0].closeCount).toBe(1)
  })

  it('closes the previous child before re-acquiring at a new fence', async () => {
    const codex = fakeCodex()
    const adapter = await acquired(codex)

    await adapter.acquire({ identity: identityFor('session-1'), fence: 8, spawnToken: 'spawn-10' })

    expect(codex.connections).toHaveLength(2)
    expect(codex.connections[0].closeCount).toBe(1)
    expect(codex.connections[1].closeCount).toBe(0)
  })

  it('keeps the traffic Codex sends before the session is published', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    codex.routes['thread/start'] = () => {
      // Codex talks as soon as the child is up, which is before the adapter has
      // a thread id to publish the session under.
      codex.connections[0].handlers.onNotification?.('item/started', { threadId: THREAD_ID })
      codex.connections[0].handlers.onServerRequest?.({
        id: 5,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'codex-item-early', threadId: THREAD_ID, turnId: 'turn-1' }
      })
      return { thread: { id: THREAD_ID } }
    }

    const adapter = await acquired(codex, {}, events)

    expect(events.map((event) => event.type)).toEqual(['notification', 'prompt'])
    // The early approval is answerable, so Codex is not left blocked on a
    // request that arrived a moment too soon.
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'codex-item-early',
      kind: 'approval',
      response: { kind: 'option', optionId: 'accept' },
      fence: 7,
      commit: async () => undefined
    })
    expect(codex.connections[0].replies).toEqual([{ id: 5, result: { decision: 'accept' } }])
  })

  it('retries a notification rejected by journal admission instead of dropping it', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    let attempts = 0
    const sink: StructuredAgentSessionEventSink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      tryAppendItem: vi.fn((identity, body, blobs) => {
        attempts += 1
        if (attempts === 1) {
          return { accepted: false as const, reason: 'backpressure' as const }
        }
        sink.appendItem(identity, body, blobs)
        return { accepted: true as const }
      })
    }
    const adapter = adapterFor(codex, {}, events)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })

    codex.connections[0].handlers.onNotification?.('item/completed', {
      item: { type: 'agentMessage', id: 'message-1', text: 'hello' }
    })

    await vi.waitFor(() => {
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'notification', method: 'item/completed' })
    })
    expect(attempts).toBe(2)
  })

  it('refuses to publish a session whose child died while it was being acquired', async () => {
    const codex = fakeCodex()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: null,
        resumeThreadId: null
      }),
      openConnection: codex.openConnection,
      // The child dies while the acquisition is still reading its identity.
      readProcessStartTime: async () => {
        codex.connections[0].closed = true
        return 1_700_000_000_000
      }
    })

    await expect(
      adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })
    ).rejects.toThrow('exited while being acquired')
    expect(codex.connections[0].closeCount).toBe(1)
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
      // Never written to a child it no longer serves: rejected, never left in doubt.
    ).resolves.toMatchObject({ state: 'rejected', rejection: { kind: 'providerExited' } })
  })

  it('classifies launch validation failure as pre-spawn without opening a child', async () => {
    const codex = fakeCodex()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => {
        throw new Error('workspace no longer exists')
      },
      openConnection: codex.openConnection
    })

    const error = await adapter
      .acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      name: 'AgentSessionPreSpawnError',
      message: 'workspace no longer exists'
    })
    expect(codex.connections).toHaveLength(0)
  })

  it('lets closeAll cancel and reap an acquisition still opening', async () => {
    const codex = fakeCodex()
    let releaseOpen = (): void => {}
    let markOpenEntered = (): void => {}
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    const openEntered = new Promise<void>((resolve) => {
      markOpenEntered = resolve
    })
    const openConnection: typeof openCodexAppServerConnection = async (...args) => {
      markOpenEntered()
      await gate
      return codex.openConnection(...args)
    }
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: null,
        resumeThreadId: null
      }),
      openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const acquiring = adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9'
    })
    await openEntered

    const closing = adapter.closeAll()
    releaseOpen()

    await expect(acquiring).rejects.toThrow('superseded while being acquired')
    await closing
    expect(codex.connections[0]?.closeCount).toBe(1)
  })

  it('fences an acquisition while launch resolution is still pending', async () => {
    const launch = Promise.withResolvers<CodexStructuredLaunch>()
    const codex = fakeCodex()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: () => launch.promise,
      openConnection: codex.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const acquiring = adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9'
    })

    const closing = adapter.closeAll()
    launch.resolve({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null
    })

    await expect(acquiring).rejects.toThrow('superseded while being acquired')
    await closing
    expect(codex.connections).toHaveLength(0)
  })
})

describe('CodexStructuredSessionAdapter.dispatch', () => {
  it('admits a send as soon as Codex owns it', async () => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-1')
    const adapter = await acquired(codex)

    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'ship it' },
          { type: 'image-ref', path: '/tmp/shot.png' },
          { type: 'image-ref', url: 'https://example.test/a.png' }
        ]
      },
      fence: 7
    })

    // Identity is not knowable here: a send coalesced into a running turn shares
    // that turn's id, so the echo settles which message landed where.
    expect(outcome).toEqual({ state: 'admitted' })
    expect(codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params).toEqual(
      {
        threadId: THREAD_ID,
        clientUserMessageId: 'client-1',
        input: [
          { type: 'text', text: 'ship it' },
          { type: 'localImage', path: '/tmp/shot.png' },
          { type: 'image', url: 'https://example.test/a.png' }
        ]
      }
    )
  })

  it('admits a send on a build whose turn/start answers before the turn is named', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const adapter = await acquired(codex, {}, events)
    codex.routes['turn/start'] = () => {
      codex.connections[0].handlers.onNotification?.('turn/started', {
        threadId: THREAD_ID,
        turn: { id: 'turn-late' }
      })
      return {}
    }

    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(outcome).toEqual({ state: 'admitted' })
    expect(events.at(-1)).toMatchObject({ type: 'notification', method: 'turn/started' })
  })

  it('does not let a child thread answer for the root thread', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    codex.routes['turn/start'] = () => {
      // A subagent runs its own thread over the same connection, and its turn
      // starts first.
      const notify = codex.connections[0].handlers.onNotification
      notify?.('turn/started', { threadId: 'thread-child', turn: { id: 'turn-child' } })
      notify?.('turn/started', { threadId: THREAD_ID, turn: { id: 'turn-root' } })
      return {}
    }
    const adapter = await acquired(codex, {}, events)

    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(outcome).toEqual({ state: 'admitted' })
    // Each event carries the thread it actually came from, so the journal can
    // keep a subagent's turn out of the root conversation.
    expect(events.map((event) => (event.type === 'notification' ? event.threadId : null))).toEqual([
      'thread-child',
      THREAD_ID
    ])
  })

  it('rejects only when Codex answered and declined', async () => {
    const codex = fakeCodex({
      'turn/start': () => {
        throw new CodexAppServerRequestError('turn/start', -32602, 'turn already running')
      }
    })
    const adapter = await acquired(codex)

    expect(
      await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).toEqual({
      // Built without Codex's own words, so nothing is quoted and no detail is invented.
      state: 'rejected',
      reason: 'The provider did not accept this message.',
      rejection: { kind: 'providerRejected' }
    })
  })

  it('rethrows a dead child so the wire settles the submission unknown', async () => {
    const codex = fakeCodex({
      'turn/start': () => {
        throw new Error('codex app-server connection ended')
      }
    })
    const adapter = await acquired(codex)

    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).rejects.toThrow('connection ended')
  })

  it('applies an option change to the next turn only', async () => {
    const codex = fakeCodex({
      'model/list': () => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
            defaultReasoningEffort: 'medium'
          },
          {
            model: 'gpt-5',
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            defaultReasoningEffort: 'high'
          }
        ],
        nextCursor: null
      })
    })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-1')
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], {
      modelCatalog: new AgentModelCatalogStore()
    })
    await adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })
    await adapter.readOptions({ sessionId: 'session-1', fence: 7 })

    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'gpt-5', fence: 7 })
    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'high', fence: 7 })
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'sandboxEscape', value: 'yes', fence: 7 })
    ).rejects.toThrow('no thread option named sandboxEscape')
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'approvalPolicy', value: 'never', fence: 7 })
    ).rejects.toThrow('no thread option named approvalPolicy')
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    const turnStart = codex.connections[0].calls.findLast((call) => call.method === 'turn/start')
    expect(turnStart?.params).toMatchObject({ model: 'gpt-5', effort: 'high' })
    expect(turnStart?.params).not.toHaveProperty('sandboxEscape')
  })
})
