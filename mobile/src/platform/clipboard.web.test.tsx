// Use real bridge lanes to prove clipboard calls reach the shell and return the device’s result.
import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub re-exported hooks to avoid Expo imports; these tests call none of them.
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
import { createMediaTestShell, encodeTestBase64, stagedTestBytes } from './media-picker-test-shell'
import { useClipboardReader, useClipboardWriter } from './clipboard.web'
import type { ClipboardReader, ClipboardWriter } from './clipboard'

const held: { writer: ClipboardWriter | null; reader: ClipboardReader | null } = {
  writer: null,
  reader: null
}

function Screen(): null {
  held.writer = useClipboardWriter()
  held.reader = useClipboardReader()
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

async function mountReader(pair: BridgePortPair): Promise<ClipboardReader> {
  await mount(pair)
  const reader = held.reader
  if (reader === null) {
    throw new Error('nothing mounted')
  }
  return reader
}

beforeEach(() => {
  held.writer = null
  held.reader = null
})

describe('writing the clipboard from inside the shell', () => {
  it('asks the shell and resolves when the pasteboard took it', async () => {
    const pair = createFakeBridgePortPair()
    const writer = await mount(pair)
    const written = writer.writeText('copied from the page')
    await pair.flush()
    await expect(written).resolves.toBeUndefined()
    expect(pair.readToShell()).toContainEqual(
      expect.objectContaining({
        type: 'request',
        method: 'native.clipboard.write',
        params: { mime: 'text', value: 'copied from the page' }
      })
    )
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
    // Inspect wire traffic to distinguish a local rejection from a failed round trip.
    expect(pair.toShell).toHaveLength(before)
  })
})

describe('reading the clipboard from inside the shell', () => {
  it('asks the shell for the text and never the desktop', async () => {
    const pair = createFakeBridgePortPair()
    const reader = await mountReader(pair)
    const read = reader.readText()
    await pair.flush()
    await expect(read).resolves.toBe('pasteboard')
    expect(pair.rpc.requests).toEqual([])
  })

  it('rejects the read on a route that was not granted it, without sending a frame', async () => {
    const pair = createFakeBridgePortPair({ routeGrants: ['navigate', 'storage'] })
    const reader = await mountReader(pair)
    const before = pair.toShell.length
    const read = reader.readText().catch((error: unknown) => error)
    await pair.flush()
    expect(String(await read)).toMatch(/did not grant/)
    expect(pair.toShell).toHaveLength(before)
  })

  // Image data can exceed reply caps and clipboard.read accepts text only; stage via media.pick, read chunks, then release, returning the native data/size shape.
  it('stages the pasteboard image, reads its bytes and gives the handle back', async () => {
    const shell = createMediaTestShell({
      staged: { clipboard: [{ bytes: stagedTestBytes(40), width: 120, height: 90 }] }
    })
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const reader = await mountReader(pair)

    const read = reader.readImage()
    await pair.flush()

    await expect(read).resolves.toEqual({
      data: encodeTestBase64(stagedTestBytes(40)),
      size: { width: 120, height: 90 }
    })
    expect(shell.released).toEqual(['media-1'])
    expect(pair.rpc.requests).toEqual([])
  })

  it('answers null for an empty pasteboard, which is the branch the paste already had', async () => {
    const shell = createMediaTestShell({ staged: {} })
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const reader = await mountReader(pair)

    const read = reader.readImage()
    await pair.flush()

    await expect(read).resolves.toBeNull()
    expect(shell.calls).toEqual(['pick clipboard single'])
  })

  it('releases every item a clipboard pick answered, not only the one it read', async () => {
    // Release every returned handle even after multiple:false; extras otherwise consume the eight-handle cap until expiry.
    const shell = createMediaTestShell({
      staged: {
        clipboard: [
          { bytes: stagedTestBytes(12), width: 4, height: 3 },
          { bytes: stagedTestBytes(20) }
        ]
      }
    })
    const pair = createFakeBridgePortPair({ serveNativeVerb: shell.serveNativeVerb })
    const reader = await mountReader(pair)

    const read = reader.readImage()
    await pair.flush()

    await expect(read).resolves.toEqual({
      data: encodeTestBase64(stagedTestBytes(12)),
      size: { width: 4, height: 3 }
    })
    expect(shell.released).toEqual(['media-1', 'media-2'])
    expect(shell.calls.filter((call) => call.startsWith('read media-2'))).toEqual([])
  })

  it('rejects the image read on a route that was not granted the pick', async () => {
    const pair = createFakeBridgePortPair({ routeGrants: ['navigate', 'storage'] })
    const reader = await mountReader(pair)
    const before = pair.toShell.length
    const read = reader.readImage().catch((error: unknown) => error)
    await pair.flush()
    expect(String(await read)).toMatch(/did not grant native\.media\.pick/)
    expect(pair.toShell).toHaveLength(before)
  })

  // No non-reading shell probe exists; reading would raise iOS paste consent on mount/foreground, so answer from available grants.
  it('reports both as possible when the read and media verbs are granted', async () => {
    const pair = createFakeBridgePortPair()
    const reader = await mountReader(pair)
    const before = pair.toShell.length
    await expect(reader.contents()).resolves.toEqual({ text: true, image: true })
    await pair.flush()
    expect(pair.toShell).toHaveLength(before)
  })

  it('reports nothing at all on a route both were withheld from', async () => {
    const pair = createFakeBridgePortPair({ routeGrants: ['navigate', 'storage'] })
    const reader = await mountReader(pair)
    await expect(reader.contents()).resolves.toEqual({ text: false, image: false })
  })

  it('reports an image as possible on a route granted the media verbs but not the read', async () => {
    const pair = createFakeBridgePortPair({
      routeGrants: [
        'navigate',
        'storage',
        'native.media.pick',
        'native.media.read',
        'native.media.release'
      ]
    })
    const reader = await mountReader(pair)
    await expect(reader.contents()).resolves.toEqual({ text: false, image: true })
  })

  it('reports no image on a route that can pick and read but not release', async () => {
    // Require pick/read/release together or swallowed cleanup refusal leaks handles until TTL and exhausts capacity.
    const pair = createFakeBridgePortPair({
      routeGrants: ['navigate', 'storage', 'native.media.pick', 'native.media.read']
    })
    const reader = await mountReader(pair)
    await expect(reader.contents()).resolves.toEqual({ text: false, image: false })
  })

  // Read-only routes can paste; requiring the write grant too would falsely disable their paste button.
  it('reports text as possible on a route granted the read but not the write', async () => {
    const pair = createFakeBridgePortPair({
      routeGrants: ['navigate', 'storage', 'native.clipboard.read']
    })
    const reader = await mountReader(pair)
    await expect(reader.contents()).resolves.toEqual({ text: true, image: false })
    const writer = held.writer
    if (writer === null) {
      throw new Error('nothing mounted')
    }
    const written = writer.writeText('x').catch((error: unknown) => error)
    await pair.flush()
    expect(String(await written)).toMatch(/did not grant/)
  })
})
