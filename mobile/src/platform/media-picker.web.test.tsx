// Drive the real port pair to verify shell-only pick/read/release and byte reconstruction.
import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub re-exported screen hooks to keep Expo out of this test runtime.
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
import {
  createMediaTestShell,
  encodeTestBase64,
  stagedTestBytes,
  type MediaTestShell
} from './media-picker-test-shell'

import { useMediaPicker } from './media-picker.web'
import type { MediaPicker, PickedMobileImage } from './media-picker-contract'

const held: { picker: MediaPicker | null } = { picker: null }

function Screen(): null {
  held.picker = useMediaPicker()
  return null
}

function render(pair: BridgePortPair): ReactElement {
  return (
    <RpcClientProvider client={pair.client}>
      <Screen />
    </RpcClientProvider>
  )
}

async function mount(pair: BridgePortPair): Promise<MediaPicker> {
  await pair.flush()
  act(() => {
    create(render(pair))
  })
  const picker = held.picker
  if (picker === null) {
    throw new Error('nothing mounted')
  }
  return picker
}

// Drain microtasks to deliver the port pair’s request/reply lanes.
async function settle<Value>(pair: BridgePortPair, work: Promise<Value>): Promise<Value> {
  const settled = work.then(
    (value) => () => value,
    (error: unknown) => () => {
      throw error
    }
  )
  await pair.flush()
  return (await settled)()
}

async function collect(
  pair: BridgePortPair,
  images: AsyncIterable<PickedMobileImage>
): Promise<PickedMobileImage[]> {
  const taken: PickedMobileImage[] = []
  const iterator = images[Symbol.asyncIterator]()
  for (;;) {
    const next = await settle(pair, iterator.next())
    if (next.done === true) {
      return taken
    }
    taken.push(next.value)
  }
}

function pairFor(shell: MediaTestShell, grants?: readonly string[]): BridgePortPair {
  return createFakeBridgePortPair({
    serveNativeVerb: shell.serveNativeVerb,
    ...(grants ? { routeGrants: grants } : {})
  })
}

// Read the refusal code because the bridge replaces handler messages.

beforeEach(() => {
  held.picker = null
})

describe('picking media from inside the shell', () => {
  it('reassembles a shell that answers shorter ranges than it was asked for', async () => {
    // Ten-byte chunks have internal base64 padding; joining decoded bytes must still preserve the file.
    const shell = createMediaTestShell({
      staged: { library: [{ bytes: stagedTestBytes(25) }] },
      chunkBytes: 10
    })
    const pair = pairFor(shell)
    const picker = await mount(pair)

    const images = await collect(pair, picker.pickImages('library'))

    expect(images.map((image) => image.base64)).toEqual([encodeTestBase64(stagedTestBytes(25))])
    expect(shell.calls).toEqual([
      'pick library multiple',
      'read media-1 0:25',
      'read media-1 10:15',
      'read media-1 20:5',
      'release media-1'
    ])
  })
})
