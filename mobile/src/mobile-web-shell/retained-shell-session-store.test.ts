import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridgeHost, type BridgeHost } from './bridge-host'
import { bridgeId, clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import {
  afterCacheRead,
  CACHED,
  MANIFEST,
  readySession,
  run
} from './mobile-web-shell-session-test-fixtures'
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

  it('keeps an in-flight manifest check and background download alive when document-started bumps the document flow', () => {
    const cachedOpen = afterCacheRead(CACHED)
    const initialFlow = cachedOpen.session.flow
    const activated = run(cachedOpen.session, {
      type: 'activated',
      flow: initialFlow,
      directory: CACHED.directory,
      sessionId: 'session-1',
      buildId: CACHED.buildId,
      totalBytes: CACHED.totalBytes,
      elapsedMs: 5
    })
    const loading = run(activated.session, { type: 'document-started' })
    expect(loading.session.flow).toBe(initialFlow + 1)

    const manifestArrived = run(loading.session, {
      type: 'manifest-read',
      flow: initialFlow,
      manifest: { ...MANIFEST, buildId: 'newer-build-id' }
    })
    expect(manifestArrived.effects).toEqual([{ kind: 'download' }])

    const updated = run(manifestArrived.session, {
      type: 'activated',
      flow: initialFlow,
      directory: '/cache/generations/newer-build-id',
      sessionId: 'session-2',
      buildId: 'newer-build-id',
      totalBytes: 2048,
      elapsedMs: 25
    })
    expect(updated.session.state).toMatchObject({
      kind: 'ready',
      sessionId: 'session-2',
      buildId: 'newer-build-id'
    })
  })

  it('resets open subscriptions on BridgeHost when a replacement document starts under the same session id', () => {
    const client = createFakeRpcClient()
    const posted: string[] = []
    const host = createBridgeHost({
      client,
      buildId: 'build-a',
      sessionId: 'session-one',
      route: { pathname: '/h/host-1' },
      pageRoutes: ['/h/[hostId]'],
      routeGrants: [],
      sessionEstablished: true,
      host: { id: 'host-1', name: 'Host One', endpoint: 'ws://host-1', lastConnected: 1 },
      readClientIdentity: () => null,
      post: (json) => {
        posted.push(json)
        return Promise.resolve()
      },
      onNavigate: () => {},
      onNavigateBack: () => 'popped',
      onExternalLink: () => {},
      onHaptic: () => {},
      serveNativeVerb: () => Promise.resolve({}),
      readStorage: () => ({ storage: {}, storageOversize: [] }),
      onStorageWrite: () => {},
      onPageFault: () => {},
      onRouteParamClear: () => {},
      onRouteRefused: () => {},
      onBinaryFramesDropped: () => {},
      onPageReady: () => {},
      onPagePainted: () => {},
      onPageBackClaim: () => {}
    })
    const subId = bridgeId(1)
    host.receive(clientFrame({ type: 'subscribe', id: subId, method: 'x.sub', params: {} }))
    expect(client.streams).toHaveLength(1)

    host.resetDocument()
    host.receive(clientFrame({ type: 'ready' }))
    host.receive(clientFrame({ type: 'subscribe', id: subId, method: 'x.sub', params: {} }))
    expect(client.streams).toHaveLength(2)
  })
})
