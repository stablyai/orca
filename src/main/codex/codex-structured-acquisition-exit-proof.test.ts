import { describe, expect, it, vi } from 'vitest'

import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

describe('Codex failed-acquisition exit proof', () => {
  it('retains a connection whose handshake cleanup could not prove exit', async () => {
    const close = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: true,
      request: async () => ({}),
      notify: () => undefined,
      respond: () => undefined,
      respondWithError: () => undefined,
      close
    }
    const handshakeError = Object.assign(new Error('initialize failed'), {
      name: 'CodexAppServerHandshakeExitUnprovenError',
      connection
    })
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: null,
        resumeThreadId: 'thread-1'
      }),
      openConnection: async () => {
        throw handshakeError
      },
      readProcessStartTime: async () => 1_700_000_000_000
    })

    await expect(
      adapter.acquire({ identity: IDENTITY, fence: 7, spawnToken: 'spawn-9' })
    ).rejects.toThrow('agent_session_acquisition_exit_unproven')
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('retains an uncommitted child until a later close proves exit', async () => {
    const close = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: false,
      request: async (method) =>
        method === 'thread/resume'
          ? { thread: { id: 'thread-1', path: '/rollouts/thread-1.jsonl' } }
          : {},
      notify: () => undefined,
      respond: () => undefined,
      respondWithError: () => undefined,
      close
    }
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: null,
        resumeThreadId: 'thread-1'
      }),
      openConnection: async () => connection,
      readProcessStartTime: async () => null
    })

    await expect(
      adapter.acquire({ identity: IDENTITY, fence: 7, spawnToken: 'spawn-9' })
    ).rejects.toThrow('agent_session_acquisition_exit_unproven')
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('keeps closeAll blocked by an unproven canceled acquisition', async () => {
    const processStart = Promise.withResolvers<number | null>()
    const readStarted = Promise.withResolvers<void>()
    const close = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: false,
      request: async () => ({ thread: { id: 'thread-1' } }),
      notify: () => undefined,
      respond: () => undefined,
      respondWithError: () => undefined,
      close
    }
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: null,
        resumeThreadId: 'thread-1'
      }),
      openConnection: async () => connection,
      readProcessStartTime: () => {
        readStarted.resolve()
        return processStart.promise
      }
    })
    const acquiring = adapter.acquire({ identity: IDENTITY, fence: 7, spawnToken: 'spawn-9' })
    await readStarted.promise

    await expect(adapter.closeAll()).rejects.toThrow(
      'codex structured session shutdown could not prove every child stopped'
    )
    processStart.resolve(null)
    await expect(acquiring).rejects.toThrow('agent_session_acquisition_exit_unproven')
    expect(close).toHaveBeenCalledTimes(4)
  })

  it('retains a child that opens after closeAll starts when exit remains unproven', async () => {
    const openStarted = Promise.withResolvers<void>()
    const releaseOpen = Promise.withResolvers<void>()
    const close = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: false,
      request: async () => ({ thread: { id: 'thread-1' } }),
      notify: () => undefined,
      respond: () => undefined,
      respondWithError: () => undefined,
      close
    }
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: null,
        resumeThreadId: 'thread-1'
      }),
      openConnection: async () => {
        openStarted.resolve()
        await releaseOpen.promise
        return connection
      },
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const acquiring = adapter.acquire({ identity: IDENTITY, fence: 7, spawnToken: 'spawn-9' })
    await openStarted.promise

    const closing = adapter.closeAll()
    releaseOpen.resolve()

    await expect(closing).rejects.toThrow(
      'codex structured session shutdown could not prove every child stopped'
    )
    await expect(acquiring).rejects.toThrow('agent_session_acquisition_exit_unproven')
    expect(close).toHaveBeenCalledTimes(4)
  })
})
