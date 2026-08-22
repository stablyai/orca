import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, linkSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { DaemonServer } from './daemon-server'
import { DaemonClient } from './client'
import { isDaemonGoneError } from './daemon-pty-adapter'
import { DAEMON_ENDPOINT_LOST_MESSAGE } from './daemon-endpoint-ownership'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session-subprocess-handle'
import { waitForEndpointUnreachable } from './daemon-endpoint-reachability-test-harness'

// A killed process must actually report its exit: teardown waits
// IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS for one that never does.
function createMockSubprocess(): SubprocessHandle {
  let notifyExit: ((code: number) => void) | null = null
  const exit = (): void => notifyExit?.(0)
  return {
    pid: 44444,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill: exit,
    forceKill: exit,
    signal() {},
    onData() {},
    onExit(callback) {
      notifyExit = callback
    },
    dispose() {}
  }
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
      // Why this matters: publishing cannot be made atomic against a publisher preempted between
      // proving an entry dead and replacing it, so this daemon can lose the endpoint at any
      // moment. If it accepted a session in that window the session would be reachable by
      // nobody — a terminal that acknowledges input and never runs it, which is the original
      // bug. Refusing makes that outcome unreachable rather than merely short-lived.
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()

      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()
      // Sanity: a session is creatable while ownership holds.
      await expect(
        client.request('createOrAttach', { sessionId: 'before', cols: 80, rows: 24 })
      ).resolves.toMatchObject({ isNew: true })

      // Another daemon takes the canonical name, exactly as a late publisher's rename would.
      const usurper = createServer()
      const usurperBind = join(dir, '.u')
      await new Promise<void>((resolve) => usurper.listen(usurperBind, resolve))
      try {
        unlinkSync(socketPath)
        linkSync(usurperBind, socketPath)

        await expect(
          client.request('createOrAttach', { sessionId: 'after', cols: 80, rows: 24 })
        ).rejects.toThrow(/no longer owns its endpoint/)

        // And it stands down rather than lingering as an unreachable host.
        const daemon = server as unknown as { retirementRequested: boolean }
        expect(daemon.retirementRequested).toBe(true)
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
      }
    }
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps serving sessions when endpoint ownership cannot be read',
    async () => {
      // Why: an unreadable stat proves nothing. Refusing sessions on it would take a daemon that
      // is serving every terminal on the machine offline because of a transient EACCES or EIO.
      // Only positive evidence of loss may refuse.
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      const daemon = server as unknown as {
        hasLostEndpointOwnership: () => boolean
        retirementRequested: boolean
      }

      try {
        // Drop search permission on the directory so the ownership stat fails EACCES.
        chmodSync(dir, 0o600)

        expect(daemon.hasLostEndpointOwnership()).toBe(false)
        expect(daemon.retirementRequested).toBe(false)
      } finally {
        chmodSync(dir, 0o700)
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'still attaches to a session it already hosts after losing the endpoint',
    async () => {
      // Why attach is exempt: it reaches a terminal already on this daemon, over a connection
      // that already exists, so it strands nothing. Refusing it would break the drain a retiring
      // daemon depends on to let live sessions finish. Note this must run without a prior
      // refusal, which would null the owned identity and disarm the guard anyway.
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

        // The guard is still armed here — no creation has been refused yet.
        const daemon = server as unknown as { hasLostEndpointOwnership: () => boolean }
        expect(daemon.hasLostEndpointOwnership()).toBe(true)

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
      // Why: retiring nulls the owned identity, so an ownership check inferred from it answers
      // "not lost" forever after. A stream socket accepted before the takeover can then finish
      // its hello, clear the pending retirement, and reopen creation on a daemon nothing can
      // reach — reinstating the exact outcome the guard exists to prevent.
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()
      // Keep one session alive: with nothing to drain the daemon now stands down the moment it
      // loses the endpoint, which is correct but would end the test before it can assert.
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

        // Simulate a late client completing its handshake and clearing pending retirement.
        const daemon = server as unknown as {
          retirementRequested: boolean
          hasLostEndpointOwnership: () => boolean
        }
        daemon.retirementRequested = false

        // The loss must still be remembered, so creation stays closed.
        expect(daemon.hasLostEndpointOwnership()).toBe(true)
        await expect(
          client.request('createOrAttach', { sessionId: 'b', cols: 80, rows: 24 })
        ).rejects.toThrow(/no longer owns its endpoint/)
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
      }
    }
  )

  it('treats the endpoint-lost refusal as a reconnectable error', () => {
    // Why pinned: the server refuses so the client can reconnect to whoever owns the endpoint.
    // If the client's retry predicate does not recognise the refusal, it surfaces to the user
    // and the request dead-ends — barely better than the strand the refusal exists to avoid.
    expect(isDaemonGoneError(new Error(DAEMON_ENDPOINT_LOST_MESSAGE))).toBe(true)
    expect(isDaemonGoneError(new Error('something else entirely'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'stands down once drained even while a pre-takeover client stays connected',
    async () => {
      // Why connections stop counting after loss: retirement drains and then exits, but idleness
      // normally waits for every client to disconnect. A client that connected before the
      // takeover can hold that open indefinitely, so the daemon would outlive its last session
      // as an orphan nothing can route to.
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

        // Losing the endpoint with nothing left to drain must stand the daemon down, even
        // though this client is still connected.
        const daemon = server as unknown as {
          requestRetirementForLostEndpoint: () => void
          idleShutdownState: string
        }
        expect(daemon.idleShutdownState).toBe('running')
        daemon.requestRetirementForLostEndpoint()

        // Drained and unreachable: it must begin standing down rather than wait for this
        // client, which can never make it routable again.
        expect(daemon.idleShutdownState).not.toBe('running')
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'still answers the refusal when losing the endpoint also begins shutdown',
    async () => {
      // Why: the guard retires synchronously, and with nothing to drain that begins shutdown
      // before the reply is written. The client must still receive the refusal it can retry on;
      // a dropped connection here would surface as an opaque failure instead of a reconnect.
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

        // No sessions, so retiring drains immediately and shutdown starts inside this call.
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
      // Why: a daemon can already be retiring because its last authenticated client dropped
      // while a session runs. Losing the endpoint is a different fact, and gating one on the
      // other meant the loss went unrecorded — after which a later hello cleared the retirement
      // and put a daemon that demonstrably could not be reached back into ordinary service.
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

        const daemon = server as unknown as {
          retirementRequested: boolean
          endpointOwnershipLost: boolean
          checkEndpointOwnership: () => void
        }
        // Retirement is already pending for an unrelated reason.
        daemon.retirementRequested = true

        daemon.checkEndpointOwnership()
        daemon.checkEndpointOwnership()

        // The loss must be recorded regardless, so a later hello cannot undo it.
        expect(daemon.endpointOwnershipLost).toBe(true)
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not retire on losses separated by a demonstrably owned observation',
    async () => {
      // Why: the watchdog retires on CONSECUTIVE losses, but an admission-time ownership read is
      // just as authoritative. When it did not reset the streak, two losses with a positive
      // owned reading between them counted as consecutive — permanently poisoning a healthy,
      // reachable daemon into refusing every later session.
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      const daemon = server as unknown as {
        checkEndpointOwnership: () => void
        hasLostEndpointOwnership: () => boolean
        endpointOwnershipLost: boolean
        endpointOwnershipLossStreak: number
      }
      // A second name for our own socket inode, so ownership can be handed back.
      const ourAlias = join(dir, '.ours')
      linkSync(socketPath, ourAlias)

      const usurper = createServer()
      const usurperBind = join(dir, '.u7')
      await new Promise<void>((resolve) => usurper.listen(usurperBind, resolve))
      try {
        // First loss.
        unlinkSync(socketPath)
        linkSync(usurperBind, socketPath)
        daemon.checkEndpointOwnership()
        expect(daemon.endpointOwnershipLossStreak).toBe(1)
        expect(daemon.endpointOwnershipLost).toBe(false)

        // Ownership demonstrably returns, observed through the admission path.
        unlinkSync(socketPath)
        linkSync(ourAlias, socketPath)
        expect(daemon.hasLostEndpointOwnership()).toBe(false)
        expect(daemon.endpointOwnershipLossStreak).toBe(0)

        // A later isolated loss is confirmation #1, not #2, so it must not retire.
        unlinkSync(socketPath)
        linkSync(usurperBind, socketPath)
        daemon.checkEndpointOwnership()
        expect(daemon.endpointOwnershipLost).toBe(false)
      } finally {
        await new Promise<void>((resolve) => usurper.close(() => resolve()))
      }
    }
  )

  it('keeps serving after an operational server error instead of dying', async () => {
    // Why: an unhandled 'error' on a net.Server is an uncaught exception. Detaching the startup
    // listener once start() settled left a daemon hosting every terminal on the machine one
    // failed accept away from termination.
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    const daemon = server as unknown as { server: Server | null }

    expect(daemon.server?.listenerCount('error')).toBe(1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Twice on purpose: a one-shot listener survives the first error and dies on the second,
      // so a single emit cannot tell a permanent handler from `once`.
      expect(() => daemon.server?.emit('error', new Error('EMFILE: accept failed'))).not.toThrow()
      expect(() =>
        daemon.server?.emit('error', new Error('EMFILE: accept failed again'))
      ).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(2)
      expect(daemon.server?.listenerCount('error')).toBe(1)
    } finally {
      warn.mockRestore()
    }

    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    expect(client.isConnected()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'stands down instead of serving when the server errors while publication is in flight',
    async () => {
      // Why: publishing awaits a liveness probe, so a server error can land mid-flight and the
      // rejection alone cannot stop it. Going on to serve would leave a live published daemon
      // behind a caller told startup failed — and a caller that responds by launching a
      // replacement recreates the split brain.
      // A dead entry on the canonical name forces publish down the probe-then-rename path, so
      // the error below lands inside the async window rather than before it.
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
      const daemon = server as unknown as { server: Server | null }
      await vi.waitFor(() => expect(daemon.server?.listening).toBe(true))
      daemon.server?.emit('error', new Error('injected accept failure'))

      await expect(started).rejects.toThrow('injected accept failure')
      // Why wait: start() rejects the moment the error lands, while publication is still in
      // flight. Reporting failure must end with the daemon actually not serving.
      await vi.waitFor(() => expect(daemon.server).toBeNull())
      await expect(waitForEndpointUnreachable(socketPath)).resolves.toBe(true)
    }
  )
})
