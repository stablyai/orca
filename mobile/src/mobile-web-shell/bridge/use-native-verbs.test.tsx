/** The page's side of the verbs, over the real pair: what it sends, and what it refuses to send. */
import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The provider module re-exports the screen hooks, and reaching the real ones imports the Expo
// runtime this test does not have. Nothing below calls one.
vi.mock('../../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => () => Promise.resolve(),
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { RpcClientProvider } from '../../transport/client-context.web'
import { createFakeBridgePortPair, type BridgePortPair } from './bridge-port-pair-test-harness'
import { GRANTS, INIT, createPageClient } from './bridge-page-client-test-harness'
import { useNativeVerbs, type NativeVerbs } from './use-native-verbs'

const held: { verbs: NativeVerbs | null } = { verbs: null }

function Screen(): null {
  held.verbs = useNativeVerbs()
  return null
}

function render(pair: BridgePortPair): ReactElement {
  return (
    <RpcClientProvider client={pair.client}>
      <Screen />
    </RpcClientProvider>
  )
}

async function mount(pair: BridgePortPair): Promise<NativeVerbs> {
  await pair.flush()
  act(() => {
    create(render(pair))
  })
  const verbs = held.verbs
  if (verbs === null) {
    throw new Error('nothing mounted')
  }
  return verbs
}

beforeEach(() => {
  held.verbs = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a page calling a native verb', () => {
  it('writes through the shell and hears whether the pasteboard took it', async () => {
    const pair = createFakeBridgePortPair()
    const verbs = await mount(pair)
    const written = verbs.writeClipboardText('copied')
    await pair.flush()
    await expect(written).resolves.toBe(true)
    // The whole point of the seam: it never reached the desktop's client.
    expect(pair.rpc.requests).toEqual([])
  })

  it('reads through the shell', async () => {
    const pair = createFakeBridgePortPair()
    const verbs = await mount(pair)
    const read = verbs.readClipboardText()
    await pair.flush()
    await expect(read).resolves.toBe('pasteboard')
    expect(pair.rpc.requests).toEqual([])
  })

  it('sends the verb as an ordinary request, which is why it settles like one', async () => {
    const pair = createFakeBridgePortPair()
    const verbs = await mount(pair)
    void verbs.readClipboardText()
    await pair.flush()
    const sent = pair.toShell
      .map((json: string) => JSON.parse(json))
      .filter((frame: { type?: string }) => frame.type === 'request')
    expect(sent).toEqual([
      expect.objectContaining({ type: 'request', method: 'native.clipboard.read' })
    ])
  })
})

describe('a shell that granted no native verbs', () => {
  it('refuses before a frame is sent, so the call costs no in-flight slot', async () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: ['navigate'] } })
    act(() => {
      create(
        <RpcClientProvider client={page.client}>
          <Screen />
        </RpcClientProvider>
      )
    })
    const verbs = held.verbs
    if (verbs === null) {
      throw new Error('nothing mounted')
    }
    expect(verbs.granted).toBe(false)
    const before = page.sent.length
    await expect(verbs.readClipboardText()).rejects.toThrow(/did not grant/)
    // A rejection after a round trip and one that never left look the same to an `await`; only the
    // first would have put a request on the wire.
    expect(page.sent).toHaveLength(before)
  })

  it('says so before it is called, so a caller can choose its own fallback', async () => {
    const pair = createFakeBridgePortPair()
    const verbs = await mount(pair)
    expect(verbs.granted).toBe(true)
  })
})

/**
 * The member exists so the raw port stays inside the module that owns it. That is only true while
 * it cannot be used as a raw port: a desktop method sent through it would reach the desktop, and
 * the inventory would not see it, because a bare-identifier call is not a shape the scan counts.
 */
describe('the native verb member on the client', () => {
  it('refuses a method outside the prefix instead of sending it to the desktop', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    // Typed `BridgeNativeVerb`, so this is a compile error too; the runtime check is what holds a
    // caller that reached the member through a widened type.
    await expect(pair.client.callNativeVerb('worktree.list' as never, { a: 1 })).rejects.toThrow(
      /not a native verb/
    )
    await pair.flush()
    expect(pair.rpc.requests).toEqual([])
  })
})
