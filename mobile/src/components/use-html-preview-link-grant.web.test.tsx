// Exercise the real init handshake so the preview reads the grant the shell actually sent.
import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Avoid Expo imports from re-exported screen hooks; this test uses none of them.
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
    // Older shells cancel navigation silently; offering links there would leave taps unanswered.
    expect(await mount(createFakeBridgePortPair({ routeGrants: [] }))).toBe(false)
  })

  // A grant refused by the manifest never reaches a shell, so check the route against the contract.
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
    // Grant names cannot use the dotted spelling reserved for verbs.
    expect(
      MobileWebBundleRouteSchema.safeParse(route([], ['native.externalNavigation'])).success
    ).toBe(false)
  })
})
