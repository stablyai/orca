import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { DeviceRegistry } from '../../rpc/server/pairing/device-registry'
import { MobileSocketWiring } from '../../rpc/mobile/mobile-socket-wiring'
import type { RelayControlClient } from '../control-channel/relay-control-client'
import type { RelayAssignment } from '../director/relay-http-client'
import { RelayControlOrigin } from './relay-control-origin'
import {
  FakeEdgePath,
  FakeHostSession,
  RESUMED_GENERATION,
  closedOnServer,
  deferred,
  untilLoopback
} from './relay-fake-edge.test-fixture'

describe('RelayControlOrigin two-path failover', () => {
  const paths: FakeEdgePath[] = []
  const origins: RelayControlOrigin[] = []
  const wirings: MobileSocketWiring[] = []
  const userDataPaths: string[] = []

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    await Promise.all(origins.splice(0).map((origin) => origin.close()))
    vi.useRealTimers()
    for (const wiring of wirings.splice(0)) {
      wiring.dispose()
    }
    await Promise.all(
      paths.splice(0).map(
        (path) =>
          new Promise<void>((resolve) => {
            for (const socket of path.server.clients) {
              socket.terminate()
            }
            path.server.close(() => resolve())
          })
      )
    )
    for (const path of userDataPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  async function setup(options: { alternates: number }) {
    const session = new FakeHostSession()
    const primary = await FakeEdgePath.listen(session)
    paths.push(primary)
    const alternates: FakeEdgePath[] = []
    for (let index = 0; index < options.alternates; index += 1) {
      const alternate = await FakeEdgePath.listen(session)
      paths.push(alternate)
      alternates.push(alternate)
    }
    const assignment: RelayAssignment = {
      v: 1,
      cellUrl: primary.url,
      assignmentEpoch: 3,
      lease: 'lease',
      ...(alternates.length > 0 ? { alternateCellUrls: alternates.map((path) => path.url) } : {})
    }
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-failover-'))
    userDataPaths.push(userDataPath)
    const wiring = new MobileSocketWiring({
      deviceRegistry: new DeviceRegistry(userDataPath),
      e2eeKeypair: session.keypair,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wirings.push(wiring)
    const closed = deferred<number>()
    const onClose = vi.fn((_origin: RelayControlOrigin, code: number) => closed.resolve(code))
    const onDrain = vi.fn()
    const dataDials: string[] = []
    const origin = new RelayControlOrigin({
      assignment,
      relayJwt: 'scoped-token',
      relayHostId: session.relayHostId,
      identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
      keypair: session.keypair,
      appVersion: '1.2.3',
      mobileSocketWiring: wiring,
      createDataSocket: (url) => {
        dataDials.push(url)
        throw new Error('test: data dials are only recorded')
      },
      onConnectionOwned: vi.fn(),
      onConnectionReleased: vi.fn(),
      onDrain,
      onDataPathUnhealthy: vi.fn(),
      onClose,
      // No start jitter: the failover dials as soon as the stall is reported.
      random: () => 0
    })
    origins.push(origin)
    const primaryConnection = primary.nextConnection()
    await origin.open()
    const primarySocket = await primaryConnection
    return {
      session,
      primary,
      primarySocket,
      primaryControl: origin.availableControl,
      alternates,
      assignment,
      origin,
      onClose,
      onDrain,
      closed: closed.promise,
      dataDials
    }
  }

  // The stalled primary stays live until the alternate's hello-ack promotes the resumed control.
  function expectPromoted(origin: RelayControlOrigin, stalled: RelayControlClient | null): void {
    expect(origin.availableControl).not.toBe(stalled)
    expect(origin.hasLiveControl()).toBe(true)
  }

  // Delivers a conn-open on the server side of the active control to see where data dials go.
  function sendConnOpen(socket: WebSocket, connId: string): void {
    socket.send(
      JSON.stringify({
        type: 'conn-open',
        connId,
        connTicket: randomBytes(32).toString('base64url'),
        kind: 'invite',
        relayDeviceId: 'device-1',
        attachDeadlineMs: 10_000
      })
    )
  }

  it('resumes the same generation on the alternate when the primary stalls', async () => {
    const {
      session,
      primary,
      primarySocket,
      primaryControl,
      alternates,
      origin,
      onClose,
      onDrain,
      dataDials
    } = await setup({ alternates: 1 })
    const [alternate] = alternates
    expect(origin.controlGeneration).toBe(RESUMED_GENERATION)
    primary.answersPings = false
    // The edge closes the old control 4408 "control rebound" at proof, before the hello-ack.
    alternate.beforeHelloAck = async () => {
      const oldClosed = closedOnServer(primarySocket)
      primarySocket.close(4408, 'control rebound')
      await oldClosed
    }

    const alternateConnection = alternate.nextConnection()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(alternate.connections).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(7_000)
    const alternateSocket = await alternateConnection
    await untilLoopback(() => expect(alternate.acks).toHaveLength(1))
    await untilLoopback(() => expectPromoted(origin, primaryControl))

    expect(alternate.hellos).toEqual([
      expect.objectContaining({
        previousGeneration: RESUMED_GENERATION,
        controlResumeSecret: expect.any(String)
      })
    ])
    expect(alternate.acks).toHaveLength(1)
    expect(origin.controlGeneration).toBe(RESUMED_GENERATION)
    expect(session.generation).toBe(RESUMED_GENERATION)
    expect(origin.cellUrl).toBe(primary.url)
    // The old control's 4408 "control rebound" is not a dead control: no director recovery.
    expect(onClose).not.toHaveBeenCalled()
    expect(onDrain).not.toHaveBeenCalled()
    expect(primary.connections).toHaveLength(1)

    // Data dials follow the path that proved itself.
    sendConnOpen(alternateSocket, 'conn-after-failover')
    await untilLoopback(() => expect(dataDials).toHaveLength(1))
    expect(dataDials[0]).toBe(
      `${alternate.url.replace('http:', 'ws:')}/v1/host/data/conn-after-failover`
    )
  })

  it('sends the resumed control a token renewed while it was still connecting', async () => {
    const { primary, primaryControl, alternates, origin, onClose } = await setup({ alternates: 1 })
    const [alternate] = alternates
    primary.answersPings = false
    // The renewal lands after the alternate's hello carried the old token, before its hello-ack:
    // the connecting control cannot take an auth-refresh yet.
    alternate.beforeHelloAck = async () => {
      origin.refreshAuthorization('renewed-token')
    }

    await vi.advanceTimersByTimeAsync(36_000)
    await untilLoopback(() => expect(alternate.acks).toHaveLength(1))
    await untilLoopback(() => expectPromoted(origin, primaryControl))

    await untilLoopback(() => expect(alternate.authRefreshes).toEqual(['renewed-token']))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('sends no extra auth-refresh when the token did not change while connecting', async () => {
    const { primary, primaryControl, alternates, origin } = await setup({ alternates: 1 })
    const [alternate] = alternates
    primary.answersPings = false

    await vi.advanceTimersByTimeAsync(36_000)
    await untilLoopback(() => expect(alternate.acks).toHaveLength(1))
    await untilLoopback(() => expectPromoted(origin, primaryControl))

    origin.refreshAuthorization('later-token')
    await untilLoopback(() => expect(alternate.authRefreshes).toEqual(['later-token']))
  })

  it('retires the old control itself when the edge’s 4408 has not arrived', async () => {
    const { primary, primarySocket, primaryControl, alternates, origin, onClose } = await setup({
      alternates: 1
    })
    const [alternate] = alternates
    primary.answersPings = false
    const primaryGone = closedOnServer(primarySocket)

    const alternateConnection = alternate.nextConnection()
    await vi.advanceTimersByTimeAsync(36_000)
    await alternateConnection
    await primaryGone
    await untilLoopback(() => expectPromoted(origin, primaryControl))
    expect(origin.controlGeneration).toBe(RESUMED_GENERATION)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('falls back to director recovery when the alternate declines the resume, without acking', async () => {
    const { session, primary, alternates, origin, onClose, closed } = await setup({
      alternates: 1
    })
    const [alternate] = alternates
    alternate.behaviour = 'decline-resume'
    primary.answersPings = false

    const alternateConnection = alternate.nextConnection()
    await vi.advanceTimersByTimeAsync(36_000)
    await alternateConnection

    await expect(closed).resolves.toBe(1006)
    expect(onClose).toHaveBeenCalledOnce()
    expect(session.generation).toBe(RESUMED_GENERATION)
    // A declined resume is never acked, so the failover cannot mint a generation.
    expect(alternate.hellos).toHaveLength(1)
    expect(alternate.acks).toEqual([])
    expect(origin.controlGeneration).toBe(RESUMED_GENERATION)
  })

  it('falls back to director recovery when the alternate is stalled too', async () => {
    const { primary, alternates, onClose, closed } = await setup({ alternates: 1 })
    const [alternate] = alternates
    alternate.behaviour = 'silent'
    primary.answersPings = false

    const alternateConnection = alternate.nextConnection()
    await vi.advanceTimersByTimeAsync(36_000)
    await alternateConnection
    await untilLoopback(() => expect(alternate.hellos).toHaveLength(1))
    expect(onClose).not.toHaveBeenCalled()

    // The alternate's 15s connect deadline expires, then the primary is dropped as today.
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(closed).resolves.toBe(1006)
    expect(onClose).toHaveBeenCalledOnce()
    expect(alternate.acks).toEqual([])
  })
})
