/**
 * The page's own question, driven through the real bridge handshake rather than a stubbed client:
 * what the preview reads is what `init` actually carried.
 *
 * `use-browser-binary-screencast-grant.web.test.tsx`'s shape, against the other token that is
 * neither a verb nor a notify.
 */
import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The provider module re-exports the screen hooks, and reaching the real ones imports the Expo
// runtime this test does not have. Nothing below calls one.
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { MobileWebBundleRouteSchema } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { BRIDGE_EXTERNAL_NAVIGATION_GRANT } from '../mobile-web-shell/cancelled-navigation-target'
import { RpcClientProvider } from '../transport/client-context.web'
import {
  createFakeBridgePortPair,
  type BridgePortPair
} from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { useHtmlPreviewLinkGrant } from './use-html-preview-link-grant.web'
import { useHtmlPreviewLinkGrant as useHtmlPreviewLinkGrantNatively } from './use-html-preview-link-grant'

const held: { granted: boolean | null } = { granted: null }

function Screen(): null {
  held.granted = useHtmlPreviewLinkGrant()
  return null
}

function render(pair: BridgePortPair): ReactElement {
  return (
    <RpcClientProvider client={pair.client}>
      <Screen />
    </RpcClientProvider>
  )
}

async function mount(pair: BridgePortPair): Promise<boolean> {
  await pair.flush()
  act(() => {
    create(render(pair))
  })
  if (held.granted === null) {
    throw new Error('nothing mounted')
  }
  return held.granted
}

beforeEach(() => {
  held.granted = null
})

describe('whether a link in the HTML preview opens, on the web', () => {
  it('is granted when the shell named it for this route', async () => {
    const pair = createFakeBridgePortPair({
      routeGrants: ['navigate', BRIDGE_EXTERNAL_NAVIGATION_GRANT]
    })
    expect(await mount(pair)).toBe(true)
  })

  it('is refused by a shell that cancels the navigation but did not grant this route', async () => {
    expect(await mount(createFakeBridgePortPair({ routeGrants: ['navigate'] }))).toBe(false)
  })

  it('is refused by a shell too old to have heard of it at all', async () => {
    // The state C8.1 exists for: every shell built before the cancelled-navigation event. It drops
    // the navigation in silence, so a tap on a rendered link would do nothing at all.
    expect(await mount(createFakeBridgePortPair({ routeGrants: [] }))).toBe(false)
  })

  it('is unconditional on native, where the preview is its own WebView', () => {
    expect(useHtmlPreviewLinkGrantNatively()).toBe(true)
  })

  // Checked against the contract rather than by eye: a route naming a grant the manifest refuses
  // never reaches a shell, so the preview would hide its links for a reason no screen could report.
  it('is a name the bundle manifest will carry, on either lane', () => {
    const route = (grants: string[], optionalGrants?: string[]) => ({
      pathname: '/h/[hostId]/session/[worktreeId]',
      grants,
      ...(optionalGrants === undefined ? {} : { optionalGrants })
    })

    expect(
      MobileWebBundleRouteSchema.safeParse(route([], [BRIDGE_EXTERNAL_NAVIGATION_GRANT])).success
    ).toBe(true)
    expect(
      MobileWebBundleRouteSchema.safeParse(route([BRIDGE_EXTERNAL_NAVIGATION_GRANT])).success
    ).toBe(true)
    // The dotted spelling this name nearly had, which the grant grammar refuses: it is not a verb.
    expect(
      MobileWebBundleRouteSchema.safeParse(route([], ['native.externalNavigation'])).success
    ).toBe(false)
  })
})
