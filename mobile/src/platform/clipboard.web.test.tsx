/**
 * The web form of the clipboard seam: the page asks the shell, and hears what it answered.
 *
 * Driven through the real port pair rather than a mocked `useNativeVerbs`, so what this reads is
 * the request leaving the page and the shell's reply coming back — the same path a tap takes.
 */
import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The provider module re-exports the screen hooks, and reaching the real ones imports the Expo
// runtime this test does not have. Nothing below calls one.
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => () => Promise.resolve(),
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
import { useClipboardWriter } from './clipboard.web'
import type { ClipboardWriter } from './clipboard'

const held: { writer: ClipboardWriter | null } = { writer: null }

function Screen(): null {
  held.writer = useClipboardWriter()
  return null
}

function render(pair: BridgePortPair): ReactElement {
  return (
    <RpcClientProvider client={pair.client}>
      <Screen />
    </RpcClientProvider>
  )
}

async function mount(pair: BridgePortPair): Promise<ClipboardWriter> {
  await pair.flush()
  act(() => {
    create(render(pair))
  })
  const writer = held.writer
  if (writer === null) {
    throw new Error('nothing mounted')
  }
  return writer
}

beforeEach(() => {
  held.writer = null
})

describe('writing the clipboard from inside the shell', () => {
  it('asks the shell and resolves when the pasteboard took it', async () => {
    const pair = createFakeBridgePortPair()
    const writer = await mount(pair)
    const written = writer.writeText('copied from the page')
    await pair.flush()
    await expect(written).resolves.toBeUndefined()
    // The whole point of the verb: it never reached the desktop.
    expect(pair.rpc.requests).toEqual([])
  })

  it('rejects when the shell says the pasteboard refused it', async () => {
    const pair = createFakeBridgePortPair({
      serveNativeVerb: () => Promise.resolve({ written: false })
    })
    const writer = await mount(pair)
    const written = writer.writeText('copied from the page').catch((error: unknown) => error)
    await pair.flush()
    expect(String(await written)).toMatch(/did not accept/)
  })

  it('rejects on a route that was not granted the verb, without sending a frame', async () => {
    const pair = createFakeBridgePortPair({ routeGrants: ['navigate', 'storage'] })
    const writer = await mount(pair)
    const before = pair.toShell.length
    const written = writer.writeText('copied from the page').catch((error: unknown) => error)
    await pair.flush()
    expect(String(await written)).toMatch(/did not grant/)
    // A rejection after a round trip and one that never left look the same to an `await`; only the
    // first would have put a request on the wire.
    expect(pair.toShell).toHaveLength(before)
  })
})
