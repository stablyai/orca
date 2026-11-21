import '../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer, type Server } from 'node:net'
import { DaemonServer } from '../daemon-server'
import type { ConnectedDaemonClient } from '../daemon-client-connections'
import { DaemonClient } from '../../transport/client/daemon-client'
import { encodeNdjson } from '../../../../shared/json-stream/main-process-ndjson-framer'
import { getDaemonSocketPath } from '../../launch/daemon-spawner'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import { PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import { waitForEndpointUnreachable } from '../../endpoint/publication/testing/daemon-endpoint-reachability-test-harness'

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
    publish(bindPath: string): Promise<void>
    hasLostOwnership(): boolean
  }
  lifecycle: {
    retirementRequested: boolean

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

        const daemon = server as unknown as DaemonServerInternals
        expect(daemon.lifecycle.retirementRequested).toBe(true)

        // Model a late hello clearing ordinary retirement.
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

  it('keeps serving after an operational server error instead of dying', async () => {
    // An unhandled net.Server error terminates the daemon and every hosted terminal.
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    const daemon = server as unknown as DaemonServerInternals

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Emit twice to distinguish a permanent error handler from a one-shot listener.
      expect(() =>
        daemon.lifecycle.server?.emit('error', new Error('EMFILE: accept failed'))
      ).not.toThrow()
      expect(() =>
        daemon.lifecycle.server?.emit('error', new Error('EMFILE: accept failed again'))
      ).not.toThrow()
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
      const daemon = server as unknown as DaemonServerInternals
      const publish = daemon.endpoint.publish.bind(daemon.endpoint)
      const publication = vi
        .spyOn(daemon.endpoint, 'publish')
        .mockImplementationOnce((bindPath) => {
          daemon.lifecycle.server?.emit('error', new Error('injected accept failure'))
          return publish(bindPath)
        })

      try {
        await expect(server.start()).rejects.toThrow('injected accept failure')
        // Startup rejects before publication settles; wait until the failed daemon actually stops serving.
        await vi.waitFor(() => expect(daemon.lifecycle.server).toBeNull())
        await expect(waitForEndpointUnreachable(socketPath)).resolves.toBe(true)
      } finally {
        publication.mockRestore()
      }
    }
  )
})
