import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { DeviceRegistry } from '../../rpc/server/pairing/device-registry'
import { MobileSocketWiring } from '../../rpc/mobile/mobile-socket-wiring'
import type { RelayAssignment } from '../director/relay-http-client'
import { RelayControlOrigin } from './relay-control-origin'
import { CONTROL_RACE_STAGGER_MS, openRacedControl } from './relay-control-race'
import {
  FakeEdgePath,
  FakeHostSession,
  RESUMED_GENERATION,
  closedOnServer,
  deferred
} from './relay-fake-edge.test-fixture'

function raceLogs(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('race'))
}

describe('RelayControlOrigin two-path connect race', () => {
  const paths: FakeEdgePath[] = []
  const origins: RelayControlOrigin[] = []
  const wirings: MobileSocketWiring[] = []
  const userDataPaths: string[] = []

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
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

  // Builds an origin over a primary and an optional alternate without opening it.
  async function setup(options: { alternate: boolean }) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new FakeHostSession()
    const primary = await FakeEdgePath.listen(session)
    const alternate = await FakeEdgePath.listen(session)
    paths.push(primary, alternate)
    const assignment: RelayAssignment = {
      v: 1,
      cellUrl: primary.url,
      assignmentEpoch: 3,
      lease: 'lease',
      ...(options.alternate ? { alternateCellUrls: [alternate.url] } : {})
    }
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-race-'))
    userDataPaths.push(userDataPath)
    const wiring = new MobileSocketWiring({
      deviceRegistry: new DeviceRegistry(userDataPath),
      e2eeKeypair: session.keypair,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wirings.push(wiring)
    const onClose = vi.fn()
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
      onDrain: vi.fn(),
      onDataPathUnhealthy: vi.fn(),
      onClose,
      random: () => 0
    })
    origins.push(origin)
    return { session, primary, alternate, assignment, origin, onClose, dataDials, warn }
  }

  // Lets a gated path's challenge go out; returns the release function.
  function gate(path: FakeEdgePath): () => void {
    const released = deferred<void>()
    path.challengeGate = released.promise
    return () => released.resolve()
  }

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

  function dataUrl(path: FakeEdgePath, connId: string): string {
    return `${path.url.replace('http:', 'ws:')}/v1/host/data/${connId}`
  }

  it('without an alternate dials once and arms no race timer', async () => {
    const opened = deferred<never>()
    const open = vi.fn(() => opened.promise)
    void openRacedControl({
      primaryUrl: 'https://primary.test',
      alternateUrl: undefined,
      isClosed: () => false,
      open
    })
    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith('https://primary.test')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(open).toHaveBeenCalledOnce()
  })

  it('without alternates a slow primary is still a single dial', async () => {
    const { primary, alternate, origin, warn } = await setup({ alternate: false })
    const release = gate(primary)
    const opening = origin.open()
    await vi.waitFor(() => expect(primary.hellos).toHaveLength(1), { interval: 1 })
    await vi.advanceTimersByTimeAsync(5_000)
    release()
    await opening
    expect(primary.connections).toHaveLength(1)
    expect(primary.acks).toHaveLength(1)
    expect(alternate.connections).toHaveLength(0)
    expect(raceLogs(warn)).toEqual([])
  })

  it('a primary that answers within the stagger never dials the alternate', async () => {
    const { primary, alternate, origin, warn } = await setup({ alternate: true })
    await origin.open()
    await vi.advanceTimersByTimeAsync(CONTROL_RACE_STAGGER_MS * 4)
    expect(primary.acks).toHaveLength(1)
    expect(alternate.connections).toHaveLength(0)
    expect(raceLogs(warn)).toEqual([])
  })

  it('a slow primary loses to the alternate and is closed unanswered', async () => {
    const { session, primary, alternate, origin, onClose, dataDials, warn } = await setup({
      alternate: true
    })
    const releasePrimary = gate(primary)
    const primaryConnection = primary.nextConnection()
    const alternateConnection = alternate.nextConnection()
    const opening = origin.open()
    const primarySocket = await primaryConnection
    const primaryClosed = closedOnServer(primarySocket)
    await vi.advanceTimersByTimeAsync(CONTROL_RACE_STAGGER_MS - 1)
    expect(alternate.connections).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    const alternateSocket = await alternateConnection
    await opening
    await primaryClosed
    releasePrimary()

    expect(primary.hellos).toHaveLength(1)
    expect(primary.acks).toEqual([])
    expect(alternate.acks).toHaveLength(1)
    expect(origin.controlGeneration).toBe(RESUMED_GENERATION)
    expect(session.generation).toBe(RESUMED_GENERATION)
    expect(origin.cellUrl).toBe(primary.url)
    expect(onClose).not.toHaveBeenCalled()
    expect(raceLogs(warn)).toEqual([
      expect.stringContaining('control race started reason=primary-slow'),
      expect.stringContaining('control race won path=alternate'),
      expect.stringContaining('control race loser closed path=primary')
    ])

    sendConnOpen(alternateSocket, 'conn-after-race')
    await vi.waitFor(() => expect(dataDials).toHaveLength(1), { interval: 1 })
    expect(dataDials[0]).toBe(dataUrl(alternate, 'conn-after-race'))
  })

  it('a primary challenge after the stagger still wins and closes the alternate unanswered', async () => {
    const { primary, alternate, origin, dataDials, warn } = await setup({ alternate: true })
    const releasePrimary = gate(primary)
    const releaseAlternate = gate(alternate)
    const primaryConnection = primary.nextConnection()
    const alternateConnection = alternate.nextConnection()
    const opening = origin.open()
    const primarySocket = await primaryConnection
    await vi.advanceTimersByTimeAsync(CONTROL_RACE_STAGGER_MS)
    const alternateSocket = await alternateConnection
    const alternateClosed = closedOnServer(alternateSocket)
    await vi.waitFor(() => expect(alternate.hellos).toHaveLength(1), { interval: 1 })

    releasePrimary()
    await opening
    await alternateClosed
    releaseAlternate()
    expect(primary.acks).toHaveLength(1)
    expect(alternate.acks).toEqual([])
    expect(raceLogs(warn)).toEqual([
      expect.stringContaining('control race started'),
      expect.stringContaining('control race won path=primary'),
      expect.stringContaining('control race loser closed path=alternate')
    ])
    sendConnOpen(primarySocket, 'conn-after-race')
    await vi.waitFor(() => expect(dataDials).toHaveLength(1), { interval: 1 })
    expect(dataDials[0]).toBe(dataUrl(primary, 'conn-after-race'))
  })

  it('a primary that fails fast dials the alternate at once', async () => {
    const { primary, alternate, origin, warn } = await setup({ alternate: true })
    await new Promise<void>((resolve) => primary.server.close(() => resolve()))
    await origin.open()
    expect(alternate.acks).toHaveLength(1)
    expect(raceLogs(warn)[0]).toContain('reason=primary-failed')
  })

  it('both paths failing rejects with the primary’s error for today’s recovery', async () => {
    const { primary, alternate, origin, warn } = await setup({ alternate: true })
    primary.behaviour = 'silent'
    alternate.behaviour = 'silent'
    const opening = origin.open()
    const rejected = expect(opening).rejects.toThrow('relay_control_connect_timeout')
    await vi.waitFor(() => expect(primary.hellos).toHaveLength(1), { interval: 1 })
    await vi.advanceTimersByTimeAsync(CONTROL_RACE_STAGGER_MS)
    await vi.waitFor(() => expect(alternate.hellos).toHaveLength(1), { interval: 1 })
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(primary.acks).toEqual([])
    expect(alternate.acks).toEqual([])
    expect(raceLogs(warn).at(-1)).toContain('control race failed on every path')
  })

  it('a control won on the alternate arms no stall detector and returns to the primary at rotation', async () => {
    const { session, primary, alternate, assignment, origin, onClose } = await setup({
      alternate: true
    })
    const releasePrimary = gate(primary)
    const opening = origin.open()
    await vi.advanceTimersByTimeAsync(CONTROL_RACE_STAGGER_MS)
    await opening
    releasePrimary()
    primary.challengeGate = null

    // Stays on the alternate even while it goes quiet: no pings, no failover.
    alternate.answersPings = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(alternate.pings).toBe(0)
    expect(onClose).not.toHaveBeenCalled()

    // Rotation resumes on the primary (a resume, so it does not race).
    const primaryReturn = primary.nextConnection()
    await origin.rebind('scoped-token', assignment)
    await primaryReturn
    expect(primary.hellos.at(-1)).toMatchObject({ previousGeneration: RESUMED_GENERATION })
    expect(alternate.connections).toHaveLength(1)
    expect(session.generation).toBe(RESUMED_GENERATION)
  })

  it('a primary that won the race still fails over to the alternate on a later stall', async () => {
    const { session, primary, alternate, origin, onClose } = await setup({ alternate: true })
    const releasePrimary = gate(primary)
    gate(alternate)
    const opening = origin.open()
    await vi.advanceTimersByTimeAsync(CONTROL_RACE_STAGGER_MS)
    await vi.waitFor(() => expect(alternate.hellos).toHaveLength(1), { interval: 1 })
    releasePrimary()
    await opening
    alternate.challengeGate = null

    primary.answersPings = false
    const failoverConnection = alternate.nextConnection()
    await vi.advanceTimersByTimeAsync(36_000)
    await failoverConnection
    await vi.waitFor(() => expect(alternate.acks).toHaveLength(1), { interval: 1 })
    await vi.waitFor(() => expect(origin.hasLiveControl()).toBe(true), { interval: 1 })
    expect(alternate.hellos).toHaveLength(2)
    expect(alternate.hellos[1]).toMatchObject({ previousGeneration: RESUMED_GENERATION })
    expect(session.generation).toBe(RESUMED_GENERATION)
    expect(onClose).not.toHaveBeenCalled()
  })
})
