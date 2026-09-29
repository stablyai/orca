import { describe, expect, it, vi } from 'vitest'

vi.mock('./mobile-e2ee-v2-client-session', () => ({
  MobileE2EEV2ClientSession: { create: () => ({}) }
}))

vi.mock('./mobile-e2ee-v2-physical-channel', () => ({
  MobileE2EEAuthenticationError: class extends Error {},
  MobileE2EEV2PhysicalChannel: class {
    start = vi.fn()
    handleMessage = vi.fn(async () => {})
    sendText = vi.fn(() => true)
    sendBinary = vi.fn(() => true)
    dispose = vi.fn()
  }
}))

import { RELAY_HOST_CLOSE_REASON } from '../../../src/shared/relay-host-close-reason'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../src/shared/mobile-relay-close-codes'
import { classifyConnection, verdictDisplayLabel } from './connection-health'
import { MobileRelayE2eeLink, RelayOuterError } from './mobile-relay-e2ee-link'
import { LogicalClientConnectionPath } from './logical-client-connection-path'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { RelayHostReachability } from './relay-host-reachability'

const SIGNED_OUT_LABEL = 'Sign-in required on Host 1'
const SIGNED_OUT_DETAIL = 'Sign in to Orca on your desktop to reconnect'

class FakeSocket {
  static readonly OPEN = 1
  readonly OPEN = FakeSocket.OPEN
  readyState = FakeSocket.OPEN
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  send = vi.fn()
  close = vi.fn()
}

function linkOver(
  socket: FakeSocket,
  onHostCloseReason: (reason: string) => void,
  onError: (error: Error) => void
): MobileRelayE2eeLink {
  return new MobileRelayE2eeLink({
    endpoint: { cellUrl: 'https://relay-c1.onorca.dev', relayHostId: 'AbCdEf0123_-xyZ9' },
    credential: 'credential',
    expectedCredentialKind: 'resume',
    deviceToken: 'device-token',
    desktopPublicKeyB64: 'desktop-key',
    onAuthenticated: vi.fn(),
    onText: vi.fn(),
    onBinary: vi.fn(),
    onHostCloseReason,
    onError,
    createSocket: () => socket as unknown as WebSocket
  })
}

describe('relay close reason on the phone', () => {
  it('reports the cell close reason and still fails with 4404', () => {
    const socket = new FakeSocket()
    const onHostCloseReason = vi.fn()
    const onError = vi.fn()
    linkOver(socket, onHostCloseReason, onError)

    socket.onclose?.({
      code: MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE,
      reason: RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    })

    expect(onHostCloseReason).toHaveBeenCalledWith(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    expect(onError).toHaveBeenCalledWith(new RelayOuterError(MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE))
  })

  // An old cell sends its constant, and every other close sends nothing.
  it('reports nothing for a reason it does not know', () => {
    const socket = new FakeSocket()
    const onHostCloseReason = vi.fn()
    linkOver(socket, onHostCloseReason, vi.fn())

    socket.onclose?.({
      code: MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE,
      reason: 'relay connection rejected'
    })

    expect(onHostCloseReason).not.toHaveBeenCalled()
  })

  // The rejection arrives as a relay-hello AND a close, in an unordered pair.
  // Whichever lands first, the reason must survive.
  it('still reports the reason when the hello already failed the link', async () => {
    const socket = new FakeSocket()
    const onHostCloseReason = vi.fn()
    linkOver(socket, onHostCloseReason, vi.fn())

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'relay-hello',
        ok: false,
        code: MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE
      })
    })
    await Promise.resolve()
    await Promise.resolve()
    socket.onclose?.({
      code: MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE,
      reason: RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    })

    expect(onHostCloseReason).toHaveBeenCalledWith(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
  })
})

describe('the signed-out signal on the logical client', () => {
  it('publishes on change and retires when any path reaches connected', () => {
    const path = new LogicalClientConnectionPath(() => false)
    const changes = vi.fn()
    path.subscribe(changes)

    path.setRelayHostReachability('signed-out')
    path.setRelayHostReachability('signed-out')
    expect(path.getRelayHostReachability()).toBe('signed-out')
    expect(changes).toHaveBeenCalledTimes(1)

    path.clearAfterConnected()
    expect(path.getRelayHostReachability()).toBe('connecting')
  })
})

describe('the sign-out the cell reported outranks a later plain 4404', () => {
  function controllerReporting(reported: RelayHostReachability[]) {
    const controller = new RelayReconnectController(
      {
        now: () => 0,
        randomBytes: () => new Uint8Array([0, 0]),
        setTimer: () => 0,
        clearTimer: () => {}
      },
      vi.fn()
    )
    controller.reportRecoveryTo({
      setRecoveryAttempt: () => {},
      setPairingRejected: () => {},
      setRelayHostReachability: (value) => reported.push(value)
    })
    return controller
  }

  // A 4404 with no reason is the cell forgetting why, not the desktop signing in.
  it('keeps the sign-out through later unlabelled host-offline closes', () => {
    const reported: RelayHostReachability[] = []
    const controller = controllerReporting(reported)

    controller.assertHostReachability('signed-out')
    controller.registerFailure(new RelayOuterError(MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE), false)
    controller.registerFailure(new RelayOuterError(MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE), false)

    expect(reported).toEqual(['connecting', 'signed-out'])
  })

  it('needs no streak: one cell close reason is the whole evidence', () => {
    const reported: RelayHostReachability[] = []
    controllerReporting(reported).assertHostReachability('signed-out')

    expect(reported.at(-1)).toBe('signed-out')
  })

  it('retires on a connection like every other verdict', () => {
    const reported: RelayHostReachability[] = []
    const controller = controllerReporting(reported)

    controller.assertHostReachability('signed-out')
    controller.setActiveSession({ getFailure: () => null })

    expect(reported).toEqual(['connecting', 'signed-out', 'connecting'])
  })
})

describe('RelayReconnectController cadence', () => {
  // The reason changes no recovery decision; 4404 keeps the host-offline
  // backoff it has always had, so a phone on this build retries exactly as
  // often as one that never hears the reason.
  it('keeps the host-offline retry delay for a 4404', () => {
    const delays: number[] = []
    const controller = new RelayReconnectController(
      {
        now: () => 0,
        randomBytes: () => new Uint8Array([0, 0]),
        setTimer: (callback, delay) => {
          delays.push(delay)
          return 1 as unknown as ReturnType<typeof setTimeout>
        },
        clearTimer: () => {}
      },
      vi.fn()
    )

    controller.registerFailure(new RelayOuterError(MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE))

    // hostOfflineDelayMs' 5s floor, not the 250ms transport-backoff floor.
    expect(delays.at(-1)).toBe(5_000)
  })
})

describe('classifyConnection with a signed-out desktop', () => {
  const base = {
    reconnectAttempts: 0,
    lastConnectedAt: null,
    relayHostReachability: 'signed-out' as const,
    hostName: 'Host 1'
  }

  it('says so from the first failed dial instead of "Connecting via Relay…"', () => {
    const verdict = classifyConnection({
      ...base,
      state: 'connecting',
      pendingPath: 'relay'
    })

    expect(verdict).toEqual({
      kind: 'unreachable',
      label: SIGNED_OUT_LABEL,
      reason: 'never-connected',
      detail: SIGNED_OUT_DETAIL
    })
    expect(verdictDisplayLabel(verdict)).toBe(SIGNED_OUT_LABEL)
  })

  it('replaces "Can\'t reach desktop" on the direct path too', () => {
    expect(
      classifyConnection({ ...base, state: 'reconnecting', reconnectAttempts: 20 }).label
    ).toBe(SIGNED_OUT_LABEL)
  })

  it('reads as stale once this session had been connected', () => {
    expect(
      classifyConnection({ ...base, state: 'reconnecting', lastConnectedAt: 1, nowMs: 2 }).reason
    ).toBe('stale')
  })

  // A Tailscale endpoint cannot make "sign in on your desktop" better advice.
  it('never appends the Tailscale hint', () => {
    expect(
      classifyConnection({ ...base, state: 'reconnecting', endpoint: '100.64.0.1' })
    ).not.toHaveProperty('hint')
  })

  it('never outranks a connected session', () => {
    expect(classifyConnection({ ...base, state: 'connected' }).label).toBe('Connected')
  })

  // Re-pairing, not signing in, is the remedy when the pairing itself is dead.
  it('never outranks a revoked pairing', () => {
    expect(classifyConnection({ ...base, state: 'reconnecting', pairingRejected: true }).kind).toBe(
      'auth-failed'
    )
  })

  it('leaves every other verdict alone when the desktop is not signed out', () => {
    expect(
      classifyConnection({
        state: 'connecting',
        reconnectAttempts: 0,
        lastConnectedAt: null,
        pendingPath: 'relay',
        relayHostReachability: 'connecting'
      }).label
    ).toBe('Connecting via Relay…')
  })
})
