import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonServer } from './daemon-server'
import { SessionNotFoundError, type DaemonRequest, type SessionInfo } from './types'

type DaemonServerPrivate = {
  host: {
    kill: (sessionId: string, opts?: { immediate?: boolean }) => void | Promise<void>
    listSessions: () => SessionInfo[]
  }
  preparations: {
    pending: Map<string, Set<{ canceled: boolean; clientId: string }>>
    cancel: (sessionId: string) => boolean
  }
  attachments: { clearInput: (sessionId: string) => void }
  requestRouter: {
    route(clientId: string, request: DaemonRequest): Promise<unknown>
  }
}

function liveSession(incarnationId: string): SessionInfo {
  return {
    sessionId: 'agent-session',
    incarnationId,
    state: 'running',
    shellState: 'unsupported',
    isAlive: true,
    pid: 1,
    cwd: null,
    cols: 80,
    rows: 24,
    createdAt: 0
  }
}

describe('daemon killOwned router ownership', () => {
  let server: DaemonServer
  let dir: string

  afterEach(async () => {
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  function startDaemon(): DaemonServerPrivate {
    dir = mkdtempSync(join(tmpdir(), 'daemon-kill-owned-'))
    server = new DaemonServer({
      socketPath: join(dir, 'daemon.sock'),
      tokenPath: join(dir, 'daemon.token'),
      log: { log: vi.fn(), close: vi.fn() },
      spawnSubprocess: () => {
        throw new Error('not used')
      }
    })
    return server as unknown as DaemonServerPrivate
  }

  it('does not cancel or clear a replacement before rejecting a stale killOwned', async () => {
    const daemon = startDaemon()
    const pendingPreparation = {
      canceled: false,
      controller: new AbortController(),
      clientId: 'control-42'
    }
    daemon.preparations.pending.set('agent-session', new Set([pendingPreparation]))
    vi.spyOn(daemon.host, 'listSessions').mockReturnValue([liveSession('replacement')])
    const kill = vi.spyOn(daemon.host, 'kill')
    const clearInput = vi.spyOn(daemon.attachments, 'clearInput')
    const cancel = vi.spyOn(daemon.preparations, 'cancel')

    await expect(
      daemon.requestRouter.route('control-42', {
        id: 'kill-owned-1',
        type: 'killOwned',
        payload: {
          sessionId: 'agent-session',
          expectedIncarnationId: 'stale-orphan',
          immediate: true
        }
      })
    ).rejects.toBeInstanceOf(SessionNotFoundError)

    expect(pendingPreparation.canceled).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
    expect(clearInput).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('kills only after killOwned ownership matches the live incarnation', async () => {
    const daemon = startDaemon()
    vi.spyOn(daemon.host, 'listSessions').mockReturnValue([liveSession('owned-incarnation')])
    const kill = vi.spyOn(daemon.host, 'kill').mockResolvedValue()
    const clearInput = vi.spyOn(daemon.attachments, 'clearInput')

    await daemon.requestRouter.route('control-42', {
      id: 'kill-owned-2',
      type: 'killOwned',
      payload: {
        sessionId: 'agent-session',
        expectedIncarnationId: 'owned-incarnation',
        immediate: true
      }
    })

    expect(clearInput).toHaveBeenCalledWith('agent-session')
    expect(kill).toHaveBeenCalledWith('agent-session', { immediate: true })
  })

  it('leaves ordinary kill cancel-before-host behavior unchanged', async () => {
    const daemon = startDaemon()
    const pendingPreparation = {
      canceled: false,
      controller: new AbortController(),
      clientId: 'control-42'
    }
    daemon.preparations.pending.set('agent-session', new Set([pendingPreparation]))
    vi.spyOn(daemon.host, 'kill').mockRejectedValue(new SessionNotFoundError('agent-session'))
    const listSessions = vi.spyOn(daemon.host, 'listSessions')

    await daemon.requestRouter.route('control-42', {
      id: 'kill-1',
      type: 'kill',
      payload: { sessionId: 'agent-session', immediate: true }
    })

    expect(pendingPreparation.canceled).toBe(true)
    expect(listSessions).not.toHaveBeenCalled()
  })
})
