import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredSessionEvent
} from './codex-structured-session-adapter'
import { handleCodexSessionExit } from './codex-structured-session-close'
import type { CodexSession } from './codex-structured-session-state'

const THREAD = 'thread-1'

function identity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: THREAD }
  }
}

function adapterFixture() {
  const connections: {
    connection: CodexAppServerConnection
    handlers: CodexAppServerConnectionHandlers
  }[] = []
  const events: CodexStructuredSessionEvent[] = []
  let generation = 0
  const openConnection = (async (_launch, handlers = {}) => {
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: false,
      request: async (method) => (method === 'thread/start' ? { thread: { id: THREAD } } : {}),
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    }
    connections.push({ connection, handlers })
    return connection
  }) as typeof openCodexAppServerConnection
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace',
      codexHome: null,
      resumeThreadId: null
    }),
    openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    mintAcquisitionGeneration: () => `generation-${++generation}`,
    onEvent: (event) => events.push(event)
  })
  return { adapter, connections, events }
}

describe('Codex structured session close lifecycle', () => {
  it('forwards a one-shot exit when lifecycle admission is rejected', () => {
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: true,
      request: async () => ({}),
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    }
    const prompts = { clear: vi.fn() } as unknown as CodexSession['prompts']
    const translator = {
      handle: vi.fn().mockReturnValueOnce({ accepted: false, reason: 'backpressure' as const }),
      dispose: vi.fn()
    } as unknown as NonNullable<CodexSession['translator']>
    const session = {
      connection,
      ended: false,
      requestedClose: false,
      fence: 7,
      acquisitionGeneration: 'generation-1',
      threadId: THREAD,
      historyPath: null,
      prompts,
      options: new Map(),
      reportedOptions: {},
      turnIdWaiters: [],
      translator
    } as CodexSession
    const sessions = new Map([['session-1', session]])
    const onEvent = vi.fn()

    expect(
      handleCodexSessionExit({
        sessions,
        sessionId: 'session-1',
        connection,
        error: new Error('provider exited'),
        prompts,
        onEvent
      })
    ).toBe(true)
    expect(session.ended).toBe(true)
    expect(prompts.clear).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledOnce()
    expect(translator.dispose).toHaveBeenCalledOnce()
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
      cause: 'unexpected-exit',
      settlementRetryRequired: true
    })
    expect(translator.handle).toHaveBeenCalledOnce()
  })

  it('mints a distinct child generation even when acquisitions share one fence', async () => {
    const { adapter } = adapterFixture()
    const input = { identity: identity('session-1'), fence: 7, spawnToken: 'spawn-1' }

    const first = await adapter.acquire(input)
    const second = await adapter.acquire(input)

    expect(first.acquisitionGeneration).toBe('generation-1')
    expect(second.acquisitionGeneration).toBe('generation-2')
  })

  it('distinguishes an observed provider death from a requested close', async () => {
    const { adapter, connections, events } = adapterFixture()
    await adapter.acquire({ identity: identity('session-1'), fence: 7, spawnToken: 'spawn-1' })
    connections[0]?.handlers.onExit?.(new Error('provider exited'))
    await adapter.acquire({ identity: identity('session-2'), fence: 9, spawnToken: 'spawn-2' })

    await adapter.closeSession('session-2')

    expect(events.filter((event) => event.type === 'ended')).toMatchObject([
      {
        cause: 'unexpected-exit',
        fence: 7,
        acquisitionGeneration: 'generation-1'
      },
      {
        cause: 'requested-close',
        fence: 9,
        acquisitionGeneration: 'generation-2'
      }
    ])
  })

  it('force-close preserves unexpected-exit evidence when the adapter reports exit during close', async () => {
    const { adapter, connections, events } = adapterFixture()
    await adapter.acquire({ identity: identity('session-1'), fence: 7, spawnToken: 'spawn-1' })
    const current = connections[0]
    if (!current) {
      throw new Error('missing connection')
    }
    current.connection.close = async () => {
      current.handlers.onExit?.(new Error('sink failed'))
      return true
    }

    await expect(adapter.forceCloseSession?.('session-1')).resolves.toBe(true)
    expect(events.filter((event) => event.type === 'ended')).toMatchObject([
      { cause: 'unexpected-exit', reason: 'sink failed', fence: 7 }
    ])
  })
})
