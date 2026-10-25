/**
 * The web half of ruling 5, driven through the real bridge handshake rather than a stubbed client:
 * what the pane reads is what `init` actually carried.
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

import { RpcClientProvider } from '../transport/client-context.web'
import {
  createFakeBridgePortPair,
  type BridgePortPair
} from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { useBrowserBinaryScreencastGrant } from './use-browser-binary-screencast-grant.web'

/** C6.1's name, restated here so a rename has to change both sides of the seam. */
const GRANT = 'screencastBinary'

const held: { granted: boolean | null } = { granted: null }

function Screen(): null {
  held.granted = useBrowserBinaryScreencastGrant()
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

describe('the binary screencast grant on the web', () => {
  it('is granted when the shell named it for this route', async () => {
    expect(await mount(createFakeBridgePortPair({ routeGrants: ['navigate', GRANT] }))).toBe(true)
  })

  it('is refused by a shell that has the encoder but did not grant this route', async () => {
    expect(await mount(createFakeBridgePortPair({ routeGrants: ['navigate'] }))).toBe(false)
  })

  it('is refused by a shell too old to have heard of it at all', async () => {
    expect(await mount(createFakeBridgePortPair({ routeGrants: [] }))).toBe(false)
  })
})
