/**
 * The web form of the media seam: the page asks the shell to pick, then reads the bytes back.
 *
 * Driven through the real port pair against a shell that stages files, so what this reads is the
 * three verbs leaving the page in order and the bytes being reassembled from what came back — the
 * same path the composer's attach button takes. The pasteboard reaches the same verbs through the
 * clipboard seam, and is `clipboard.web.test.tsx`'s.
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
import { BRIDGE_MEDIA_READ_MAX_BYTES } from '../mobile-web-shell/bridge/bridge-media-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'
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
import { NativeVerbError } from '../mobile-web-shell/bridge/use-native-verbs'
import { useMediaPicker } from './media-picker.web'
import type { MediaPicker, PickedMobileImage } from './media-picker-contract'

/** Three chunks: two full ones and a short tail, so the `eof` boundary is not the cap boundary. */
const THREE_CHUNKS = BRIDGE_MEDIA_READ_MAX_BYTES * 2 + 17

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

/** The pair delivers on microtasks, so a call the page makes needs the lanes drained under it. */
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

function libraryShell(items: number, byteLength = THREE_CHUNKS): MediaTestShell {
  return createMediaTestShell({
    staged: {
      library: Array.from({ length: items }, () => ({ bytes: stagedTestBytes(byteLength) }))
    }
  })
}

function pairFor(shell: MediaTestShell, grants?: readonly string[]): BridgePortPair {
  return createFakeBridgePortPair({
    serveNativeVerb: shell.serveNativeVerb,
    ...(grants ? { routeGrants: grants } : {})
  })
}

/** The shell's code, off the rejection the bridge rebuilt: the message is the host's, not the
 *  handler's, so the code is the only part of a refusal a page may read. */
function refusalCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

beforeEach(() => {
  held.picker = null
})

describe('picking media from inside the shell', () => {
  it('reads every chunk of every item in order and releases each as it finishes', async () => {
    const shell = libraryShell(2)
    const pair = pairFor(shell)
    const picker = await mount(pair)

    const images = await collect(pair, picker.pickImages('library'))

    expect(images.map((image) => image.base64)).toEqual([
      encodeTestBase64(stagedTestBytes(THREE_CHUNKS)),
      encodeTestBase64(stagedTestBytes(THREE_CHUNKS))
    ])
    expect(shell.calls).toEqual([
      'pick library multiple',
      `read media-1 0:${BRIDGE_MEDIA_READ_MAX_BYTES}`,
      `read media-1 ${BRIDGE_MEDIA_READ_MAX_BYTES}:${BRIDGE_MEDIA_READ_MAX_BYTES}`,
      `read media-1 ${BRIDGE_MEDIA_READ_MAX_BYTES * 2}:17`,
      'release media-1',
      `read media-2 0:${BRIDGE_MEDIA_READ_MAX_BYTES}`,
      `read media-2 ${BRIDGE_MEDIA_READ_MAX_BYTES}:${BRIDGE_MEDIA_READ_MAX_BYTES}`,
      `read media-2 ${BRIDGE_MEDIA_READ_MAX_BYTES * 2}:17`,
      'release media-2'
    ])
    // The whole point of the verbs: nothing reached the desktop.
    expect(pair.rpc.requests).toEqual([])
  })

  it('refuses a chunk of a handle it already released, which is what ends a read', async () => {
    const shell = libraryShell(1)
    const pair = pairFor(shell)
    const picker = await mount(pair)
    await collect(pair, picker.pickImages('library'))
    expect(shell.released).toEqual(['media-1'])

    // The same handle the seam finished with, asked for again through the page's own client: the
    // release is a fact about the shell, not bookkeeping this side chose to believe. The code is
    // what is asserted, because the host replaces a handler's own words on the way out.
    const refused = settle(
      pair,
      pair.client.callNativeVerb('native.media.read', {
        handle: 'media-1',
        offset: 0,
        length: 16
      })
    ).catch((error: unknown) => error)
    expect(refusalCode(await refused)).toBe('native_media_handle_unknown')
  })

  it('takes the first of a single pick and releases the one it never read', async () => {
    // `multiple: false` still lets a picker answer more than one item on some providers, and the
    // seam's one-image caller would otherwise strand every extra handle until the TTL.
    const shell = createMediaTestShell({
      staged: { library: [{ bytes: stagedTestBytes(9) }, { bytes: stagedTestBytes(9) }] }
    })
    const pair = pairFor(shell)
    const picker = await mount(pair)

    const image = await settle(pair, picker.pickImage('library'))

    expect(image?.base64).toBe(encodeTestBase64(stagedTestBytes(9)))
    expect(shell.released).toEqual(['media-1', 'media-2'])
    expect(shell.calls.filter((call) => call.startsWith('read media-2'))).toEqual([])
  })

  it('answers null for a picker the user cancelled, and nothing for an empty selection', async () => {
    const shell = createMediaTestShell({ staged: {} })
    const pair = pairFor(shell)
    const picker = await mount(pair)

    expect(await settle(pair, picker.pickImage('files'))).toBeNull()
    expect(await collect(pair, picker.pickImages('files'))).toEqual([])
    expect(shell.calls).toEqual(['pick files single', 'pick files multiple'])
  })

  it('reads an empty staged item once rather than looping on a zero-length read', async () => {
    // The shell's schema refuses `length: 0`, so an empty file has to be asked for as one byte and
    // answered `eof` — the one case where the read is not derived from what is left.
    const shell = libraryShell(1, 0)
    const pair = pairFor(shell)
    const picker = await mount(pair)

    const images = await collect(pair, picker.pickImages('library'))

    expect(images).toEqual([{ base64: '' }])
    expect(shell.calls).toEqual(['pick library multiple', 'read media-1 0:1', 'release media-1'])
  })

  it('reassembles a shell that answers shorter ranges than it was asked for', async () => {
    // Ten bytes at a time, which is not a whole base64 group: each chunk's own padding would land
    // in the middle of the file if a reader joined the strings instead of the bytes. The wire
    // promises `eof` and nothing about the length, so this is a shell within its contract.
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

  it('names a shell that answers nothing and does not report the end', async () => {
    const shell = createMediaTestShell({
      staged: { library: [{ bytes: stagedTestBytes(25) }] },
      chunkBytes: 0
    })
    const pair = pairFor(shell)
    const picker = await mount(pair)

    const refused = await settle(pair, picker.pickImage('library')).catch((error: unknown) => error)

    expect(String(refused)).toMatch(/answered no bytes for media-1 and did not report the end/)
    // Named rather than spun on: the loop has no other exit, and the handle still goes back.
    expect(shell.released).toEqual(['media-1'])
  })

  it('names a shell that ends a read short of the length it declared', async () => {
    const shell = createMediaTestShell({
      staged: { library: [{ bytes: stagedTestBytes(25) }] },
      endAt: 12
    })
    const pair = pairFor(shell)
    const picker = await mount(pair)

    const refused = await settle(pair, picker.pickImage('library')).catch((error: unknown) => error)

    expect(String(refused)).toMatch(/answered 12 bytes for an item it declared as 25/)
    expect(shell.released).toEqual(['media-1'])
  })

  /**
   * Every refusal a pick can answer with, through one path.
   *
   * The cap is the registry's, raised before a picker runs; the ceiling is ruling 6c's, raised
   * once a picked item has been weighed. Both cross as an `error` frame and both have to reach the
   * caller as a reason it can switch on, because an empty list would have told it the user changed
   * their mind — and a code outside the seam's vocabulary floors instead of crossing verbatim.
   */
  it.each([
    ['native_media_handle_cap', 'this page is holding every staged item it may'],
    ['native_media_too_large', 'a picked item is 20000000 bytes, over what this shell stages']
  ] as const)('rejects a pick the shell refused as %s', async (code, message) => {
    const shell = createMediaTestShell({
      staged: {},
      refusePick: new BridgeNativeVerbRefusedError(code, message)
    })
    const pair = pairFor(shell)
    const picker = await mount(pair)

    const refused = await settle(pair, picker.pickImage('library')).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(NativeVerbError)
    expect(refused instanceof NativeVerbError ? refused.reason : null).toBe(code)
  })

  it('rejects on a route that was not granted the verb, without sending a frame', async () => {
    const shell = libraryShell(1)
    const pair = pairFor(shell, ['navigate', 'storage'])
    const picker = await mount(pair)
    const before = pair.toShell.length

    const refused = settle(pair, picker.pickImage('library')).catch((error: unknown) => error)

    expect(String(await refused)).toMatch(/did not grant native\.media\.pick/)
    expect(pair.toShell).toHaveLength(before)
    expect(shell.calls).toEqual([])
  })
})
