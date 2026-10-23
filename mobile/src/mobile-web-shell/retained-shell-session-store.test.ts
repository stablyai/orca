import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeHost } from './bridge-host'
import { readySession, run } from './mobile-web-shell-session-test-fixtures'
import {
  evictRetainedShellSession,
  parkRetainedBridgeHost,
  recordRetainedShellSession,
  takeRetainedBridgeHost,
  type RetainedBridgeHostBinding
} from './retained-shell-session-store'
import type { MobileWebShellBridgeArgs } from './use-mobile-web-shell-bridge'
import type { MobileWebShellSession } from './mobile-web-shell-session-contract'

function paintedSession(): MobileWebShellSession {
  return run(readySession().session, { type: 'page-ready' }, { type: 'page-painted' }).session
}

function parkedHost(): BridgeHost {
  // SAFETY: take and dispose only call dispose(); the rest of BridgeHost is unused here.
  return { dispose: vi.fn() } as BridgeHost
}

function binding(overflowed = false): RetainedBridgeHostBinding {
  // SAFETY: park, take, and dispose never read binding.args.
  const args = {} as MobileWebShellBridgeArgs
  return {
    args,
    clientId: null,
    post: null,
    queuedOutboundFrames: [],
    disposed: false,
    overflowed
  }
}

function parkPainted(client: object, host: BridgeHost, slot = binding()) {
  const session = paintedSession()
  if (session.state.kind !== 'ready') {
    throw new Error('fixture session is not ready')
  }
  recordRetainedShellSession({
    hostId: 'host-1',
    routePathname: session.routePathname,
    wide: session.wide,
    appNamesRoute: session.appNamesRoute,
    client,
    session
  })
  expect(
    parkRetainedBridgeHost({
      hostId: 'host-1',
      sessionId: session.state.sessionId,
      buildId: session.state.buildId,
      client,
      host,
      binding: slot
    })
  ).toBe(true)
  return session.state
}

describe('takeRetainedBridgeHost', () => {
  beforeEach(() => {
    evictRetainedShellSession()
  })

  it('returns a parked bridge that matches the host, client, and document', () => {
    const client = {}
    const host = parkedHost()
    const state = parkPainted(client, host)
    const taken = takeRetainedBridgeHost({
      hostId: 'host-1',
      sessionId: state.sessionId,
      buildId: state.buildId,
      client
    })
    expect(taken?.host).toBe(host)
    expect(host.dispose).not.toHaveBeenCalled()
    expect(
      takeRetainedBridgeHost({
        hostId: 'host-1',
        sessionId: state.sessionId,
        buildId: state.buildId,
        client
      })
    ).toBeNull()
  })

  it('disposes a parked bridge when another client asks for it', () => {
    const client = {}
    const host = parkedHost()
    const state = parkPainted(client, host)
    expect(
      takeRetainedBridgeHost({
        hostId: 'host-1',
        sessionId: state.sessionId,
        buildId: state.buildId,
        client: {}
      })
    ).toBeNull()
    expect(host.dispose).toHaveBeenCalledTimes(1)
    expect(
      takeRetainedBridgeHost({
        hostId: 'host-1',
        sessionId: state.sessionId,
        buildId: state.buildId,
        client
      })
    ).toBeNull()
  })

  it('disposes a parked bridge when another host asks for it', () => {
    const client = {}
    const host = parkedHost()
    const state = parkPainted(client, host)
    expect(
      takeRetainedBridgeHost({
        hostId: 'host-2',
        sessionId: state.sessionId,
        buildId: state.buildId,
        client
      })
    ).toBeNull()
    expect(host.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes a parked bridge whose document or client record does not match', () => {
    const client = {}
    const sessionMismatch = parkedHost()
    const sessionState = parkPainted(client, sessionMismatch)
    expect(
      takeRetainedBridgeHost({
        hostId: 'host-1',
        sessionId: 'other-session',
        buildId: sessionState.buildId,
        client
      })
    ).toBeNull()
    expect(sessionMismatch.dispose).toHaveBeenCalledTimes(1)

    const buildMismatch = parkedHost()
    const buildState = parkPainted(client, buildMismatch)
    expect(
      takeRetainedBridgeHost({
        hostId: 'host-1',
        sessionId: buildState.sessionId,
        buildId: 'f'.repeat(64),
        client
      })
    ).toBeNull()
    expect(buildMismatch.dispose).toHaveBeenCalledTimes(1)

    const overflowed = parkedHost()
    const slot = binding()
    const overflowState = parkPainted(client, overflowed, slot)
    slot.overflowed = true
    expect(
      takeRetainedBridgeHost({
        hostId: 'host-1',
        sessionId: overflowState.sessionId,
        buildId: overflowState.buildId,
        client
      })
    ).toBeNull()
    expect(overflowed.dispose).toHaveBeenCalledTimes(1)
  })
})
