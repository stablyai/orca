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
import {
  MobileFileTooLargeError,
  type MediaPicker,
  type PickedMobileFile,
  type PickedMobileImage
} from './media-picker-contract'

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

// Read the refusal code because the bridge replaces handler messages.
function refusalCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

beforeEach(() => {
  held.picker = null
})

describe('picking media from inside the shell', () => {
  it('reads every chunk of every item in order and releases each as it finishes', async () => {
    const shell = createMediaTestShell({
      staged: {
        library: [
          { bytes: stagedTestBytes(THREE_CHUNKS) },
          { bytes: new Uint8Array(THREE_CHUNKS).fill(0xa5) }
        ]
      }
    })
    const pair = pairFor(shell)
    const picker = await mount(pair)

    const images = await collect(pair, picker.pickImages('library'))

    expect(images.map((image) => image.base64)).toEqual([
      encodeTestBase64(stagedTestBytes(THREE_CHUNKS)),
      encodeTestBase64(new Uint8Array(THREE_CHUNKS).fill(0xa5))
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
    expect(pair.rpc.requests).toEqual([])
  })

  it('refuses a chunk of a handle it already released, which is what ends a read', async () => {
    const shell = libraryShell(1)
    const pair = pairFor(shell)
    const picker = await mount(pair)
    await collect(pair, picker.pickImages('library'))
    expect(shell.released).toEqual(['media-1'])

    // Re-read the released handle through the client to prove shell cleanup, not just local bookkeeping.
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
    // Providers may return extras for multiple:false; release them before they occupy capacity until TTL.
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
    // The schema refuses length:0, so ask for one byte to receive eof for an empty file.
    const shell = libraryShell(1, 0)
    const pair = pairFor(shell)
    const picker = await mount(pair)

    const images = await collect(pair, picker.pickImages('library'))

    expect(images).toEqual([{ base64: '' }])
    expect(shell.calls).toEqual(['pick library multiple', 'read media-1 0:1', 'release media-1'])
  })

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

  it('names a shell that answers nothing and does not report the end', async () => {
    const shell = createMediaTestShell({
      staged: { library: [{ bytes: stagedTestBytes(25) }] },
      chunkBytes: 0
    })
    const pair = pairFor(shell)
    const picker = await mount(pair)

    const refused = await settle(pair, picker.pickImage('library')).catch((error: unknown) => error)

    expect(String(refused)).toMatch(/answered no bytes for media-1 and did not report the end/)
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

  // Refusals must retain named reasons instead of looking like user cancellation; unknown codes fall back to the seam’s vocabulary.
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

describe('picking files from inside the shell', () => {
  async function collectFiles(pair: BridgePortPair, picker: MediaPicker) {
    const taken: PickedMobileFile[] = []
    const iterator = picker.pickFiles()[Symbol.asyncIterator]()
    for (;;) {
      const next = await settle(pair, iterator.next())
      if (next.done === true) {
        return taken
      }
      taken.push(next.value)
    }
  }

  it("names each file with the shell's own name when the shell serves it", async () => {
    const shell = createMediaTestShell({
      staged: {
        files: [{ bytes: stagedTestBytes(12), mime: 'application/pdf', name: 'auth-spec.pdf' }]
      }
    })
    const pair = pairFor(shell)
    const picker = await mount(pair)

    expect(await collectFiles(pair, picker)).toEqual([
      {
        name: 'auth-spec.pdf',
        mime: 'application/pdf',
        byteLength: 12,
        base64: encodeTestBase64(stagedTestBytes(12))
      }
    ])
    expect(shell.released).toEqual(['media-1'])
  })

  it("names a non-image files pick for the terminal upload and leaves an image's to the host", async () => {
    const shell = createMediaTestShell({
      staged: {
        files: [
          { bytes: stagedTestBytes(3), mime: 'image/png', name: 'diagram.png' },
          { bytes: stagedTestBytes(3), mime: 'text/plain', name: 'notes.txt' }
        ]
      }
    })
    const pair = pairFor(shell)
    const picker = await mount(pair)

    expect(await collect(pair, picker.pickImages('files'))).toEqual([
      { base64: encodeTestBase64(stagedTestBytes(3)) },
      { base64: encodeTestBase64(stagedTestBytes(3)), fileName: 'notes.txt' }
    ])
  })

  it('names the file from its type on a shell too old to name it', async () => {
    const shell = createMediaTestShell({
      staged: {
        files: [
          { bytes: stagedTestBytes(3), mime: 'application/pdf', name: 'ignored.pdf' },
          { bytes: stagedTestBytes(3), mime: 'text/markdown' }
        ]
      }
    })
    const pair = pairFor(shell, ['native.media.pick', 'native.media.read', 'native.media.release'])
    const picker = await mount(pair)

    const files = await collectFiles(pair, picker)

    expect(files.map((file) => file.name)).toEqual(['attachment-1.pdf', 'attachment-2.md'])
    expect(shell.calls.filter((call) => call.startsWith('name'))).toEqual([])
  })

  it('reads the shell refusing a file over what it stages as the size error', async () => {
    const shell = createMediaTestShell({
      staged: {},
      refusePick: new BridgeNativeVerbRefusedError('native_media_too_large', 'too large')
    })
    const pair = pairFor(shell)
    const picker = await mount(pair)

    const refused = await collectFiles(pair, picker).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(MobileFileTooLargeError)
  })
})
