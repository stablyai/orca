import {
  codexStartReport,
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
import { CodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import type { openCodexAppServerConnection } from '../../app-server/codex-app-server-connection'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import type {
  CodexStructuredLaunch,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'

describe('CodexStructuredSessionAdapter.acquire', () => {
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
      effort: 'medium',
      reportedPermissionMode: null
    })
    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toEqual({
      current: { model: 'gpt-live', effort: 'medium', reportedPermissionMode: null },
      models: [
        {
          id: 'gpt-live',
          label: 'GPT Live',
          description: 'gpt-live',
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
})
