import {
  codexStartReport,
  codexStartedLink,
  acquireReadyCodexForTest,
  THREAD_ID,
  USER_MESSAGE,
  acquired,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
import { describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerRequestError,
  type openCodexAppServerConnection
} from './codex-app-server-connection'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredLaunch,
  type CodexStructuredSessionEvent
} from './codex-structured-session-adapter'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { createCodexStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'

describe('CodexStructuredSessionAdapter.acquire', () => {
  it('keeps a started thread usable when its model listing never answers', async () => {
    const codex = fakeCodex({ 'model/list': () => new Promise<never>(() => {}) })
    const adapter = adapterFor(codex)

    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'gpt-saved', effort: 'low', serviceTier: 'priority' }
    })

    expect(codexStartReport(adapter).reportedOptions).toEqual({
      model: 'gpt-saved',
      effort: 'low',
      serviceTier: 'priority'
    })
    expect(codex.connections[0].calls.map((call) => call.method)).toEqual([
      'initialize',
      'thread/start',
      'skills/list'
    ])
  })

  it('keeps a saved next-turn pick when resuming a thread that reports its previous pick', async () => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = () => ({ turn: { id: 'turn-1' } })
    const adapter = adapterFor(codex, { resumeThreadId: THREAD_ID })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'gpt-next', effort: 'low' }
    })

    const saved = codexStartReport(adapter).reportedOptions
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
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 8,
      spawnToken: 'spawn-10',
      options: {
        ...(saved.model ? { model: saved.model } : {}),
        ...(saved.effort ? { effort: saved.effort } : {})
      }
    })
    expect(codexStartReport(adapter).reportedOptions).toMatchObject({
      model: 'gpt-next',
      effort: 'low'
    })
  })

  it('keeps current intent usable without inventing controls when a listing fails', async () => {
    const codex = fakeCodex({
      'model/list': () => {
        throw new Error('stub model/list rejected')
      }
    })
    const adapter = adapterFor(codex)

    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'gpt-live', effort: 'medium' }
    })

    expect(codexStartReport(adapter).reportedOptions).toEqual({
      model: 'gpt-live',
      effort: 'medium'
    })
    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toEqual({
      current: { model: 'gpt-live', effort: 'medium' },
      models: [
        {
          id: 'gpt-live',
          label: 'gpt-live',
          isDefault: false,
          efforts: [],
          effortsKnown: false
        }
      ]
    })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-1')
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'after-listing-failure',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    expect(
      codex.connections[0].calls.findLast((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ model: 'gpt-live', effort: 'medium' })
    expect(codex.connections[0].closeCount).toBe(0)
  })

  it('opens the thread with the chat identity every command must keep', async () => {
    const codex = fakeCodex()
    const record = agentSessionRecordFixture({
      sessionId: 'session-1',
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/codex/home' }
    })
    const adapter = adapterFor(codex, {}, [], {
      resolveLaunch: createCodexStructuredLaunchResolver({
        store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
        resolveWorkspacePath: async () => '/work/repo',
        resolveCommand: () => 'codex',
        resolveLaunchArgs: () => []
      })
    })

    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9'
    })

    expect(codex.connections[0].calls[1]).toEqual({
      method: 'thread/start',
      params: {
        cwd: '/work/repo',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        approvalsReviewer: 'user',
        // Explicit values survive inherit = core.
        config: {
          'shell_environment_policy.set.ORCA_AGENT_SESSION_ID': 'session-1',
          'shell_environment_policy.set.ORCA_STRUCTURED_SESSION': '1',
          'shell_environment_policy.set.ORCA_CLI_COMMAND': expect.stringMatching(
            /^[^:;]*[\\/]cli[\\/]bin[\\/]orca-dev$/
          ),
          'shell_environment_policy.set.ORCA_USER_DATA_PATH': expect.any(String),
          'shell_environment_policy.set.ORCA_ENVIRONMENT': '',
          'shell_environment_policy.set.ORCA_PAIRING_CODE': '',
          'shell_environment_policy.set.ORCA_REMOTE_PAIRING': ''
        }
      }
    })
  })

  it('resumes the thread the durable handle chain names, not the client one', async () => {
    const codex = fakeCodex()
    const adapter = adapterFor(codex, {
      resumeThreadId: 'thread-proven'
    })

    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 9,
      spawnToken: 'spawn-9'
    })

    expect(codex.connections[0].calls[1]).toEqual({
      method: 'thread/resume',
      params: expect.objectContaining({
        threadId: 'thread-proven',
        cwd: '/work/repo'
      })
    })
    expect(codexStartedLink(adapter)?.origin).toBe('resumed')
    expect(codexStartedLink(adapter)?.handle).toEqual(codexProviderHandle('thread-proven'))
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

    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 9,
      spawnToken: 'spawn-9'
    })

    expect(codex.connections[0].calls.slice(1, 3).map((call) => call.method)).toEqual([
      'thread/resume',
      'thread/start'
    ])
    expect(codexStartedLink(adapter)).toEqual({
      linkId: `codex-9-${THREAD_ID}`,
      handle: codexProviderHandle(THREAD_ID),
      origin: 'created',
      supersedesKey: 'codex:"thread-unsaved"',
      mintedAtFence: 9,
      observedAt: 1_700_000_000_500
    })
    expect(codex.connections[0].closeCount).toBe(0)
  })

  it('rejects a resume that lands on a different thread; the host closes once', async () => {
    const codex = fakeCodex({ 'thread/resume': () => ({ thread: { id: 'thread-other' } }) })
    const adapter = adapterFor(codex, { resumeThreadId: 'thread-proven' })
    const acquired = await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 9,
      spawnToken: 'spawn-9'
    })
    await expect(
      adapter.open({
        sessionId: 'session-1',
        fence: 9,
        acquisitionGeneration: acquired.acquisitionGeneration ?? null,
        signal: new AbortController().signal
      })
    ).rejects.toThrow('resumed thread-other instead of thread-proven')
    expect(codex.connections[0].closeCount).toBe(0)
    expect(await adapter.closeSession('session-1')).toBe(true)
    expect(codex.connections[0].closeCount).toBe(1)
  })

  it('keeps the traffic Codex sends before the session is published', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    codex.routes['thread/start'] = () => {
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
    await acquireReadyCodexForTest(adapter, {
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
    ).rejects.toThrow('no live codex app-server')
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

    // Coalesced sends share a turn ID; the echo supplies message identity.
    expect(outcome).toMatchObject({ state: 'admitted' })
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

    expect(outcome).toMatchObject({ state: 'admitted' })
    expect(events.at(-1)).toMatchObject({ type: 'notification', method: 'turn/started' })
  })

  it('does not let a child thread answer for the root thread', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    codex.routes['turn/start'] = () => {
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

    expect(outcome).toMatchObject({ state: 'admitted' })
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
      state: 'rejected',
      reason: "Codex didn't accept this message.",
      rejection: { kind: 'providerRejected', neverReachedAgent: true }
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
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9'
    })
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
