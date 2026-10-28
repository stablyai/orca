import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer, type Server } from 'node:net'
import { DaemonServer } from './daemon-server'
import type { ConnectedDaemonClient } from './daemon-client-connections'
import { DaemonClient } from './client'
import { isDaemonGoneError } from './daemon-endpoint-errors'
import { DAEMON_ENDPOINT_LOST_MESSAGE } from './daemon-endpoint-ownership'
import { encodeNdjson } from './ndjson'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session-subprocess-handle'
import { PROTOCOL_VERSION } from './types'
import { waitForEndpointUnreachable } from './daemon-endpoint-reachability-test-harness'

// Report physical exit so teardown does not wait for the kill deadline.
function createMockSubprocess(): SubprocessHandle {
  let notifyExit: ((code: number) => void) | null = null
  const exit = (): void => notifyExit?.(0)
  return {
    pid: 44444,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill: exit,
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: exit,
    signal() {},
    onData() {},
    onExit(callback) {
      notifyExit = callback
    },
    dispose() {}
  }
}
type DaemonServerInternals = {
  endpoint: {
    hasLostOwnership(): boolean
    requestRetirementForLoss(): void
    checkOwnership(): void
    ownershipLossStreak: number
    ownershipLost: boolean
  }
  lifecycle: {
    retirementRequested: boolean
    state: string
    server: Server | null
  }
  connections: { clients: Map<string, ConnectedDaemonClient> }
}

describe('daemon server error handling', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let client: DaemonClient | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-server-errors-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')
  })

  afterEach(async () => {
    client?.disconnect()
    client = null
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'refuses to create a session on an endpoint it no longer owns',
    async () => {
      // A competing publisher can win after our probe; admitting new sessions would strand their PTYs.
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()

      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()
      await expect(
        client.request('createOrAttach', { sessionId: 'before', cols: 80, rows: 24 })
      ).resolves.toMatchObject({ isNew: true })

      // Model a late publisher taking the canonical endpoint.
      const usurper = createServer()
      const usurperBind = join(dir, '.u')
      await new Promise<void>((resolve) => usurper.listen(usurperBind, resolve))
      try {
        unlinkSync(socketPath)
        linkSync(usurperBind, socketPath)

        await expect(
          client.request('createOrAttach', { sessionId: 'after', cols: 80, rows: 24 })
        ).rejects.toThrow(/no longer owns its endpoint/)

        const daemon = server as unknown as DaemonServerInternals
        expect(daemon.lifecycle.retirementRequested).toBe(true)
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
      }
    }
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps serving sessions when endpoint ownership cannot be read',
    async () => {
      // Unreadable ownership is unknown; only proven loss may close session admission.
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      const daemon = server as unknown as DaemonServerInternals

      try {
        // Directory search permission is required to stat the endpoint.
        chmodSync(dir, 0o600)

        expect(daemon.endpoint.hasLostOwnership()).toBe(false)
        expect(daemon.lifecycle.retirementRequested).toBe(false)
      } finally {
        chmodSync(dir, 0o700)
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'still attaches to a session it already hosts after losing the endpoint',
    async () => {
      // Existing transports can still attach to hosted sessions, allowing retirement to drain them.
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()
      await client.request('createOrAttach', { sessionId: 'live', cols: 80, rows: 24 })

      const usurper = createServer()
      const usurperBind = join(dir, '.u2')
      await new Promise<void>((resolve) => usurper.listen(usurperBind, resolve))
      try {
        unlinkSync(socketPath)
        linkSync(usurperBind, socketPath)

        const daemon = server as unknown as DaemonServerInternals
        expect(daemon.endpoint.hasLostOwnership()).toBe(true)

        await expect(
          client.request('createOrAttach', {
            sessionId: 'live',
            cols: 80,
            rows: 24,
            attachOnly: true
          })
        ).resolves.toMatchObject({ isNew: false })
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'never reopens session creation after the endpoint was lost',
    async () => {
      // Endpoint loss must outlive retirement state, which a late authenticated hello can clear.
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()
      // Keep a session alive so retirement cannot shut the daemon down before the assertions.
      await client.request('createOrAttach', { sessionId: 'draining', cols: 80, rows: 24 })

      const usurper = createServer()
      const usurperBind = join(dir, '.u3')
      await new Promise<void>((resolve) => usurper.listen(usurperBind, resolve))
      try {
        unlinkSync(socketPath)
        linkSync(usurperBind, socketPath)

        await expect(
          client.request('createOrAttach', { sessionId: 'a', cols: 80, rows: 24 })
        ).rejects.toThrow(/no longer owns its endpoint/)

        // Model a late hello clearing ordinary retirement.
        const daemon = server as unknown as DaemonServerInternals
        daemon.lifecycle.retirementRequested = false

        expect(daemon.endpoint.hasLostOwnership()).toBe(true)
        await expect(
          client.request('createOrAttach', { sessionId: 'b', cols: 80, rows: 24 })
        ).rejects.toThrow(/no longer owns its endpoint/)
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
      }
    }
  )

  it('treats the endpoint-lost refusal as a reconnectable error', () => {
    expect(isDaemonGoneError(new Error(DAEMON_ENDPOINT_LOST_MESSAGE))).toBe(true)
    expect(isDaemonGoneError(new Error('something else entirely'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'stands down once drained even while a pre-takeover client stays connected',
    async () => {
      // Pre-takeover clients must not keep a drained, unreachable daemon alive.
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()

      const usurper = createServer()
      const usurperBind = join(dir, '.u4')
      await new Promise<void>((resolve) => usurper.listen(usurperBind, resolve))
      try {
        unlinkSync(socketPath)
        linkSync(usurperBind, socketPath)

        const daemon = server as unknown as DaemonServerInternals
        expect(daemon.lifecycle.state).toBe('running')
        daemon.endpoint.requestRetirementForLoss()

        expect(daemon.lifecycle.state).not.toBe('running')
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'still answers the refusal when losing the endpoint also begins shutdown',
    async () => {
      // Flush the reconnectable refusal before synchronous retirement destroys the transport.
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()

      const usurper = createServer()
      const usurperBind = join(dir, '.u5')
      await new Promise<void>((resolve) => usurper.listen(usurperBind, resolve))
      try {
        unlinkSync(socketPath)
        linkSync(usurperBind, socketPath)

        await expect(
          client.request('createOrAttach', { sessionId: 'x', cols: 80, rows: 24 })
        ).rejects.toThrow(/no longer owns its endpoint/)
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'records endpoint loss even when already retiring for another reason',
    async () => {
      // Endpoint loss must be recorded independently of ordinary retirement, which hello can clear.
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()
      await client.request('createOrAttach', { sessionId: 'keepalive', cols: 80, rows: 24 })

      const usurper = createServer()
      const usurperBind = join(dir, '.u6')
      await new Promise<void>((resolve) => usurper.listen(usurperBind, resolve))
      try {
        unlinkSync(socketPath)
        linkSync(usurperBind, socketPath)

        const daemon = server as unknown as DaemonServerInternals
        daemon.lifecycle.retirementRequested = true

        daemon.endpoint.checkOwnership()
        daemon.endpoint.checkOwnership()

        expect(daemon.endpoint.ownershipLost).toBe(true)
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not retire on losses separated by a demonstrably owned observation',
    async () => {
      // Admission-time ownership proof must reset the watchdog's consecutive-loss streak too.
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      const daemon = server as unknown as DaemonServerInternals
      // Preserve an alias to our socket so the test can restore ownership.
      const ourAlias = join(dir, '.ours')
      linkSync(socketPath, ourAlias)

      const usurper = createServer()
      const usurperBind = join(dir, '.u7')
      await new Promise<void>((resolve) => usurper.listen(usurperBind, resolve))
      try {
        unlinkSync(socketPath)
        linkSync(usurperBind, socketPath)
        daemon.endpoint.checkOwnership()
        expect(daemon.endpoint.ownershipLossStreak).toBe(1)
        expect(daemon.endpoint.ownershipLost).toBe(false)

        // Restore ownership through the admission path.
        unlinkSync(socketPath)
        linkSync(ourAlias, socketPath)
        expect(daemon.endpoint.hasLostOwnership()).toBe(false)
        expect(daemon.endpoint.ownershipLossStreak).toBe(0)

        unlinkSync(socketPath)
        linkSync(usurperBind, socketPath)
        daemon.endpoint.checkOwnership()
        expect(daemon.endpoint.ownershipLost).toBe(false)
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
      }
    }
  )

  it('keeps serving after an operational server error instead of dying', async () => {
    // An unhandled net.Server error terminates the daemon and every hosted terminal.
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    const daemon = server as unknown as DaemonServerInternals

    expect(daemon.lifecycle.server?.listenerCount('error')).toBe(1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Emit twice to distinguish a permanent error handler from a one-shot listener.
      expect(() =>
        daemon.lifecycle.server?.emit('error', new Error('EMFILE: accept failed'))
      ).not.toThrow()
      expect(() =>
        daemon.lifecycle.server?.emit('error', new Error('EMFILE: accept failed again'))
      ).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(2)
      expect(daemon.lifecycle.server?.listenerCount('error')).toBe(1)
    } finally {
      warn.mockRestore()
    }

    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    expect(client.isConnected()).toBe(true)
  })

  it('rejects unsupported hello roles without replacing an authenticated stream', async () => {
    const onAuthenticatedClientPair = vi.fn()
    server = new DaemonServer({
      socketPath,
      tokenPath,
      onAuthenticatedClientPair,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    const daemon = server as unknown as DaemonServerInternals
    const connectedClient = [...daemon.connections.clients.values()][0]
    const originalStream = connectedClient.streamSocket

    const unsupported = connect(socketPath)
    unsupported.on('error', () => {})
    await new Promise<void>((resolve) => unsupported.once('connect', resolve))
    const response = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      unsupported.once('data', (data) => resolve(JSON.parse(data.toString())))
    })
    unsupported.write(
      encodeNdjson({
        type: 'hello',
        version: PROTOCOL_VERSION,
        token: readFileSync(tokenPath, 'utf8'),
        clientId: connectedClient.clientId,
        role: 'observer'
      })
    )
    await expect(response).resolves.toMatchObject({ ok: false, error: 'Invalid role' })
    unsupported.destroy()

    expect(connectedClient.streamSocket).toBe(originalStream)
    expect(connectedClient.authenticatedPairEstablished).toBe(true)
    expect(onAuthenticatedClientPair).toHaveBeenCalledOnce()
  })

  it.skipIf(process.platform === 'win32')(
    'stands down instead of serving when the server errors while publication is in flight',
    async () => {
      // A publication can outlive startup rejection; prevent the failed launch from serving beside its replacement.
      // A dead canonical entry forces the asynchronous probe-to-rename path.
      const stale = createServer()
      const stalePath = join(dir, '.bstale00001')
      await new Promise<void>((resolve) => stale.listen(stalePath, resolve))
      linkSync(stalePath, socketPath)
      await new Promise<void>((resolve) => stale.close(() => resolve()))

      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      const started = server.start()
      const daemon = server as unknown as DaemonServerInternals
      await vi.waitFor(() => expect(daemon.lifecycle.server?.listening).toBe(true))
      daemon.lifecycle.server?.emit('error', new Error('injected accept failure'))

      await expect(started).rejects.toThrow('injected accept failure')
      // Startup rejects before publication settles; wait until the failed daemon actually stops serving.
      await vi.waitFor(() => expect(daemon.lifecycle.server).toBeNull())
      await expect(waitForEndpointUnreachable(socketPath)).resolves.toBe(true)
    }
  )
})
