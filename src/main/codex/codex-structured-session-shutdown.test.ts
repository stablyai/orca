import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type {
  CodexAppServerConnection,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredLaunch
} from './codex-structured-session-adapter'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-1'
const LAUNCH: CodexStructuredLaunch = {
  command: 'codex',
  args: ['app-server'],
  cwd: '/work/repo',
  codexHome: null,
  resumeThreadId: null
}

function identity(): AgentSessionJournalIdentity {
  return {
    sessionId: SESSION_ID,
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: THREAD_ID }
  }
}

describe('CodexStructuredSessionAdapter shutdown', () => {
  it('refuses acquisitions that enter after closeAll starts', async () => {
    const connections: CodexAppServerConnection[] = []
    const openConnection = (async () => {
      const connection = {
        pid: 4321,
        closed: false,
        request: async (method: string) =>
          method === 'thread/start' ? { thread: { id: THREAD_ID } } : {},
        notify: () => {},
        respond: () => {},
        respondWithError: () => {},
        close: async () => true
      } satisfies CodexAppServerConnection
      connections.push(connection)
      return connection
    }) as typeof openCodexAppServerConnection
    const firstLaunch = Promise.withResolvers<CodexStructuredLaunch>()
    let launchCount = 0
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: () => {
        launchCount += 1
        return launchCount === 1 ? firstLaunch.promise : Promise.resolve(LAUNCH)
      },
      openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const first = adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-1' })
    await vi.waitFor(() => expect(launchCount).toBe(1))

    const closing = adapter.closeAll()
    const second = adapter.acquire({ identity: identity(), fence: 8, spawnToken: 'spawn-2' })
    const acquisitions = Promise.allSettled([first, second])
    firstLaunch.resolve(LAUNCH)

    const [firstResult, secondResult] = await acquisitions
    await closing
    expect(firstResult).toMatchObject({ status: 'rejected' })
    expect(secondResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'codex structured session adapter is closing' })
    })
    expect(connections).toHaveLength(0)
  })

  it('bounds shutdown when a provider child never proves exit', async () => {
    const close = vi.fn(async () => false)
    const openConnection = (async () =>
      ({
        pid: 4321,
        closed: false,
        request: async (method: string) =>
          method === 'thread/start' ? { thread: { id: THREAD_ID } } : {},
        notify: () => {},
        respond: () => {},
        respondWithError: () => {},
        close
      }) satisfies CodexAppServerConnection) as typeof openCodexAppServerConnection
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => LAUNCH,
      openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })

    await adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-1' })
    await expect(adapter.closeAll()).rejects.toThrow(
      'codex structured session shutdown could not prove every child stopped'
    )
    expect(close).toHaveBeenCalledTimes(3)
  })
})
