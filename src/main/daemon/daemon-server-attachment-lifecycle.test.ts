import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonClient } from './client'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { CreateOrAttachOptions, CreateOrAttachResult } from './terminal-host'

function createMockSubprocess(): SubprocessHandle {
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 55_555,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit(callback) {
      onExit = callback
    },
    dispose: vi.fn()
  }
}

type DaemonAttachmentPrivate = {
  host: {
    detach: (sessionId: string, token: symbol) => void
    detachClients: (attachments: readonly { sessionId: string; token: symbol }[]) => void
    createOrAttach: (options: CreateOrAttachOptions) => Promise<CreateOrAttachResult>
    sessions: Map<string, { hasAttachedClients: boolean }>
  }
  connections: {
    clients: Map<string, { streamSocket: Socket | null }>
  }
  attachments: {
    clientIdBySessionId: Map<string, string>
    tokenBySessionId: Map<string, symbol>
  }
}

describe('DaemonServer attachment lifecycle', () => {
  let directory: string
  let server: DaemonServer
  let client: DaemonClient

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'daemon-attachment-lifecycle-'))
    const socketPath = getDaemonSocketPath(directory)
    const tokenPath = join(directory, 'daemon.token')
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: createMockSubprocess
    })
    await server.start()
    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
  })

  afterEach(async () => {
    client.disconnect()
    await server.shutdown()
    rmSync(directory, { recursive: true, force: true })
  })

  async function createSession(sessionId: string): Promise<void> {
    await client.request('createOrAttach', { sessionId, cols: 80, rows: 24 })
  }

  it('parks attached sessions when their stream transport closes', async () => {
    await createSession('transport-owned-session')
    const daemon = server as unknown as DaemonAttachmentPrivate
    const detachClients = vi.spyOn(daemon.host, 'detachClients')
    const streamSocket = [...daemon.connections.clients.values()][0]?.streamSocket

    streamSocket?.destroy()

    await vi.waitFor(() => expect(detachClients).toHaveBeenCalledOnce())
    expect(detachClients.mock.calls[0]?.[0]).toEqual([
      { sessionId: 'transport-owned-session', token: expect.any(Symbol) }
    ])
    expect(daemon.host.sessions.get('transport-owned-session')?.hasAttachedClients).toBe(false)
    expect(daemon.attachments.clientIdBySessionId.has('transport-owned-session')).toBe(false)
    expect(daemon.attachments.tokenBySessionId.has('transport-owned-session')).toBe(false)
  })

  it('parks only the requesting client attachment on explicit detach', async () => {
    await createSession('explicitly-detached-session')
    const daemon = server as unknown as DaemonAttachmentPrivate
    const detach = vi.spyOn(daemon.host, 'detach')

    await client.request('detach', { sessionId: 'explicitly-detached-session' })

    expect(detach).toHaveBeenCalledWith('explicitly-detached-session', expect.any(Symbol))
    expect(daemon.host.sessions.get('explicitly-detached-session')?.hasAttachedClients).toBe(false)
    expect(daemon.attachments.clientIdBySessionId.has('explicitly-detached-session')).toBe(false)
    expect(daemon.attachments.tokenBySessionId.has('explicitly-detached-session')).toBe(false)
  })

  it('parks an attachment completed after its transport already closed', async () => {
    const daemon = server as unknown as DaemonAttachmentPrivate
    const originalCreateOrAttach = daemon.host.createOrAttach.bind(daemon.host)
    let attachmentCreated!: () => void
    let finishRequest!: () => void
    const created = new Promise<void>((resolve) => {
      attachmentCreated = resolve
    })
    const gate = new Promise<void>((resolve) => {
      finishRequest = resolve
    })
    vi.spyOn(daemon.host, 'createOrAttach').mockImplementation(async (options) => {
      const result = await originalCreateOrAttach(options)
      attachmentCreated()
      await gate
      return result
    })
    const request = client
      .request('createOrAttach', { sessionId: 'close-race-session', cols: 80, rows: 24 })
      .catch(() => undefined)
    await created

    client.disconnect()
    await vi.waitFor(() => expect(daemon.connections.clients.size).toBe(0))
    expect(daemon.host.sessions.get('close-race-session')?.hasAttachedClients).toBe(true)
    finishRequest()

    await request
    await vi.waitFor(() =>
      expect(daemon.host.sessions.get('close-race-session')?.hasAttachedClients).toBe(false)
    )
    expect(daemon.attachments.clientIdBySessionId.has('close-race-session')).toBe(false)
    expect(daemon.attachments.tokenBySessionId.has('close-race-session')).toBe(false)
  })
})
