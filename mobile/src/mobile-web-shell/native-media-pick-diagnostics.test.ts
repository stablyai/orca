import { createElement, useLayoutEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_NATIVE_VERB_NAMES, type BridgeNativeVerb } from './bridge/bridge-native-verbs'
import { bridgeId, clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import type { FakeRpcClient } from './bridge-host-test-fakes'
import {
  useMobileWebShellBridge,
  type MobileWebShellBridgeView
} from './use-mobile-web-shell-bridge'
import { connectionLogStore } from '../transport/persisted-connection-log-store'

const doubles = vi.hoisted((): { client: FakeRpcClient | null } => ({ client: null }))
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: doubles.client })
}))

const serveNativeVerb = vi.fn<(verb: BridgeNativeVerb, params: unknown) => Promise<unknown>>()
const held: { view: MobileWebShellBridgeView | null } = { view: null }
let tree: ReactTestRenderer | null = null

function Screen(): null {
  const view = useMobileWebShellBridge({
    hostId: 'host-1',
    session: {
      kind: 'ready',
      generationDirectory: '/private-cache',
      sessionId: 'session-a',
      buildId: 'build-a',
      totalBytes: 4096,
      elapsedMs: 1
    },
    sessionEstablished: true,
    route: { pathname: '/h/host-1' },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    keyboardInset: 0,
    pageRoutes: ['/h/[hostId]'],
    pageRouteGrants: [],
    routeGrants: [...BRIDGE_NATIVE_VERB_NAMES],
    snapshot: { host: { id: 'host-1', name: 'Host', endpoint: 'ws://host-1', lastConnected: 0 } },
    serveNativeVerb,
    readStorage: () => ({ storage: {}, storageOversize: [] }),
    onNavigate: () => {},
    onExternalLink: () => {},
    onHaptic: () => {},
    onNavigateBack: () => 'nothing-to-pop',
    onStorageWrite: () => {},
    onPageFault: () => {},
    onPageReady: () => {},
    onPagePainted: () => {},
    onPageBackClaim: () => {},
    onRouteParamClear: () => {},
    onRouteRefused: () => {},
    onBinaryFramesDropped: () => {}
  })
  held.view = view
  useLayoutEffect(() => {
    view.viewRef({ postBridgeMessage: async () => {} })
    return () => view.viewRef(null)
  }, [view.viewRef])
  return null
}

async function mount(): Promise<number> {
  await act(async () => {
    tree = create(createElement(Screen))
  })
  return connectionLogStore.get('host-1').length
}

async function pick(params: unknown): Promise<void> {
  await act(async () => {
    held.view?.onBridgeMessage({
      nativeEvent: {
        json: clientFrame({
          type: 'request',
          id: bridgeId(1),
          method: 'native.media.pick',
          params
        })
      }
    })
  })
}

beforeEach(() => {
  doubles.client = createFakeRpcClient()
  serveNativeVerb.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  held.view = null
  vi.restoreAllMocks()
})

describe('persisted native media picker diagnostics', () => {
  it.each([
    ['native_media_permission_denied', 'native_media_permission_denied'],
    ['native_media_handle_cap', 'native_media_handle_cap'],
    ['native_media_too_large', 'native_media_too_large'],
    ['unrecognized-private-code', 'native_verb_failed']
  ])('persists only the checked picker refusal for %s', async (code, reason) => {
    serveNativeVerb.mockRejectedValue(
      Object.assign(new Error('private /photos/secret.jpg data:image/png;base64,AAAA'), {
        code,
        route: '/h/private-host/private-worktree'
      })
    )
    const before = await mount()
    await pick({ source: 'library', multiple: true })
    await pick({ source: 'library', multiple: true })
    const entries = connectionLogStore.get('host-1').slice(before)
    expect(
      entries.map(({ level, code, message, detail }) => ({ level, code, message, detail }))
    ).toEqual([
      {
        level: 'warn',
        code: 'web-shell-bridge',
        message: 'Web shell bridge: native-media-pick-refused',
        detail: `source=library stage=handler reason=${reason}`
      }
    ])
    expect(doubles.client?.requests).toEqual([])
  })

  it('distinguishes pre-dispatch and result refusals without retaining params or results', async () => {
    const before = await mount()
    await pick({ source: 'library', multiple: 'private-filename.jpg' })
    expect(serveNativeVerb).not.toHaveBeenCalled()
    await pick({ source: '/photos/private.jpg', multiple: true })
    serveNativeVerb.mockResolvedValue({ items: 'private-result' })
    await pick({ source: 'library', multiple: true })
    expect(
      connectionLogStore
        .get('host-1')
        .slice(before)
        .map((line) => line.detail)
    ).toEqual([
      'source=library stage=pre-dispatch reason=native_verb_params',
      'source=unreported stage=pre-dispatch reason=native_verb_params',
      'source=library stage=result reason=native_verb_result'
    ])
  })

  it('keeps a cancelled picker silent in the persisted diagnostics', async () => {
    serveNativeVerb.mockResolvedValue({ items: [] })
    const before = await mount()
    await pick({ source: 'library', multiple: true })
    expect(connectionLogStore.get('host-1').slice(before)).toEqual([])
  })
})
