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

  /**
   * The image, which crosses as a handle and then as chunks.
   *
   * `native.clipboard.read` admits only `text`, so an image mime is `invalid-params` rather than a
   * refusal of its own, and a 24 MiB base64 image cannot cross an 8 MiB reply cap either way. So
   * the pasteboard's image is `native.media.pick { source: 'clipboard' }`: the shell stages it, the
   * bytes come back under the frame cap, and the handle goes back. What the caller sees is the
   * `{ data, size }` the phone's `getImageAsync` answers.
   */
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
    // The pick ran and answered nothing; no read, no release.
    expect(shell.calls).toEqual(['pick clipboard single'])
  })

  it('releases every item a clipboard pick answered, not only the one it read', async () => {
    // `multiple: false` is what the page asks for, not what a shell promises: a caller that took
    // the first of several would hold the rest against the eight-handle cap until the TTL.
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
    // The second went back without being read.
    expect(shell.calls.filter((call) => call.startsWith('read media-2'))).toEqual([])
  })

  it('rejects the image read on a route that was not granted the pick', async () => {
    const pair = createFakeBridgePortPair({ routeGrants: ['navigate', 'storage'] })
    const reader = await mountReader(pair)
    const before = pair.toShell.length
    const read = reader.readImage().catch((error: unknown) => error)
    await pair.flush()
    // A refused pick and an empty clipboard lead a caller to different screens, so this is not
    // folded into the null above.
    expect(String(await read)).toMatch(/did not grant native\.media\.pick/)
    expect(pair.toShell).toHaveLength(before)
  })

  /**
   * `contents` is not a probe here and cannot be one: the shell serves no "is there text" verb, and
   * reading to find out would raise iOS's paste-consent prompt on every mount and every foreground,
   * which is the whole reason the phone has `hasStringAsync`. So it answers what this side knows.
   */
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
    // Per grant, not on the pair: the two halves of the paste are granted separately and a screen
    // told its clipboard was empty would never enable the button for either.
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
    // All three or none. Every image read releases what it picked, and a shell that never takes a
    // handle back holds the staged file to the five-minute TTL — eight pastes and the next pick is
    // refused at the cap, with the failed release swallowed on the way there by design.
    const pair = createFakeBridgePortPair({
      routeGrants: ['navigate', 'storage', 'native.media.pick', 'native.media.read']
    })
    const reader = await mountReader(pair)
    await expect(reader.contents()).resolves.toEqual({ text: false, image: false })
  })

  /**
   * The read grant on its own is enough to paste, so it is the grant this answers on.
   *
   * Asking whether both clipboard verbs are granted is the right question for a screen that copies
   * and pastes and the wrong one here: a route granted only the read would have been told its
   * clipboard was empty, and its paste button would never enable.
   */
  it('reports text as possible on a route granted the read but not the write', async () => {
    const pair = createFakeBridgePortPair({
      routeGrants: ['navigate', 'storage', 'native.clipboard.read']
    })
    const reader = await mountReader(pair)
    await expect(reader.contents()).resolves.toEqual({ text: true, image: false })
    // And the write still refuses, so the grants really are asymmetric rather than all present.
    const writer = held.writer
    if (writer === null) {
      throw new Error('nothing mounted')
    }
    const written = writer.writeText('x').catch((error: unknown) => error)
    await pair.flush()
    expect(String(await written)).toMatch(/did not grant/)
  })
})
