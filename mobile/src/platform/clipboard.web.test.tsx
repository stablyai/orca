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
   * The degradation, recorded rather than implied.
   *
   * No shell reads an image for the page yet — `native.clipboard.read` admits only `text`, so an
   * image mime is `invalid-params` rather than a refusal of its own, and a 24 MiB base64 image
   * cannot cross an 8 MiB reply cap. The pasteboard's image is `native.media.pick
   * { source: 'clipboard' }`, landed in C7.4 and unwired until C7.6. So the page answers what an
   * empty clipboard answers and the terminal's paste takes the branch it already had.
   */
  it('answers no image, without asking the shell for one', async () => {
    const pair = createFakeBridgePortPair()
    const reader = await mountReader(pair)
    const before = pair.toShell.length
    await expect(reader.readImage()).resolves.toBeNull()
    await pair.flush()
    expect(pair.toShell).toHaveLength(before)
  })

  /**
   * `contents` is not a probe here and cannot be one: the shell serves no "is there text" verb, and
   * reading to find out would raise iOS's paste-consent prompt on every mount and every foreground,
   * which is the whole reason the phone has `hasStringAsync`. So it answers what this side knows.
   */
  it('reports text as possible when the read verb is granted, and never an image', async () => {
    const pair = createFakeBridgePortPair()
    const reader = await mountReader(pair)
    const before = pair.toShell.length
    await expect(reader.contents()).resolves.toEqual({ text: true, image: false })
    await pair.flush()
    expect(pair.toShell).toHaveLength(before)
  })

  it('reports no text at all on a route the read verb was withheld from', async () => {
    const pair = createFakeBridgePortPair({ routeGrants: ['navigate', 'storage'] })
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
    // And the write still refuses, so the pair really is asymmetric rather than both granted.
    const writer = held.writer
    if (writer === null) {
      throw new Error('nothing mounted')
    }
    const written = writer.writeText('x').catch((error: unknown) => error)
    await pair.flush()
    expect(String(await written)).toMatch(/did not grant/)
  })
})
