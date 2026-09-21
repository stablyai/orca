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
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import { BRIDGE_NATIVE_VERB_NAMES } from './bridge-native-verbs'
import { createFakeBridgePortPair, type BridgePortPair } from './bridge-port-pair-test-harness'
import { GRANTS, INIT, createPageClient } from './bridge-page-client-test-harness'
import {
  NATIVE_VERB_REASONS,
  NativeVerbError,
  useNativeVerbs,
  type NativeVerbs
} from './use-native-verbs'

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
    // The compile-time half, held by the tests-typecheck ratchet: widening the parameter back to
    // `string` makes this directive unused and fails there. The call still runs, which is the
    // runtime half — a caller that reached the member through a widened type.
    // @ts-expect-error a desktop method is not a native verb
    const sent = pair.client.callNativeVerb('worktree.list', { a: 1 })
    await expect(sent).rejects.toThrow(/not a native verb/)
    await pair.flush()
    expect(pair.rpc.requests).toEqual([])
  })
})

/**
 * Every refusal reaches the caller under one type, carrying the shell's own code.
 *
 * Without this a caller had to read message text to tell an out-of-scope mime from a clipboard too
 * large to send, and those are different things to do something about.
 */
describe('a verb the shell refuses', () => {
  async function rejectionFrom(serveNativeVerb: () => Promise<unknown>): Promise<NativeVerbError> {
    const pair = createFakeBridgePortPair({ serveNativeVerb })
    const verbs = await mount(pair)
    const read = verbs.readClipboardText().catch((error: unknown) => error)
    await pair.flush()
    const caught = await read
    if (!(caught instanceof NativeVerbError)) {
      throw new Error(`expected a NativeVerbError, got ${String(caught)}`)
    }
    return caught
  }

  it('names an out-of-scope mime as its own reason, without the handler message', async () => {
    // A coded error, not the handler's class: what the host reads is the `code` property, so this
    // is the contract between the two and importing the real class would pull react-native in.
    const declined = Object.assign(new Error('image is not served by this build'), {
      code: 'native_verb_out_of_scope'
    })
    const error = await rejectionFrom(() => Promise.reject(declined))
    expect(error.reason).toBe('native_verb_out_of_scope')
    // The handler's words stay on the device: this one names the mime, and a read that failed
    // after reading could name what it read.
    expect(error.message).not.toContain('image')
  })

  it('separates a device failure from an out-of-scope one, which is the point of the codes', async () => {
    const error = await rejectionFrom(() => Promise.reject(new Error('the pasteboard is gone')))
    expect(error.reason).toBe('native_verb_failed')
    expect(error.message).not.toContain('pasteboard')
  })

  it('answers a reason from the declared list for every arm a caller can reach', async () => {
    const reasons = [
      (await rejectionFrom(() => Promise.reject(new Error('x')))).reason,
      (await rejectionFrom(() => Promise.resolve({ value: 'a'.repeat(9 * 1024 * 1024) }))).reason,
      (await rejectionFrom(() => Promise.resolve({ nonsense: 1 }))).reason
    ]
    // No `unreported`: every path this build can take names itself.
    for (const reason of reasons) {
      expect(NATIVE_VERB_REASONS, reason).toContain(reason)
      expect(reason).not.toBe('unreported')
    }
    expect(reasons).toEqual(['native_verb_failed', 'reply-too-large', 'native_verb_result'])
  })

  it('names the frame refusal when the reply could never have reached the page', async () => {
    const error = await rejectionFrom(() => Promise.resolve({ value: 'a'.repeat(9 * 1024 * 1024) }))
    expect(error.reason).toBe('reply-too-large')
  })

  it('names the grant when this side refused before sending', async () => {
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
    await expect(verbs.readClipboardText()).rejects.toMatchObject({ reason: 'ungranted' })
  })
})

describe('a code this page has never heard of', () => {
  it('floors to unreported rather than crossing verbatim', async () => {
    // Delivered as a frame, not through the pair: this build's host normalises an unknown code to
    // `native_verb_failed` before it leaves, so the only way to be a page reading a shell newer
    // than itself is to be handed the frame such a shell would send.
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: [...BRIDGE_NATIVE_VERB_NAMES] } })
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
    const read = verbs.readClipboardText().catch((error: unknown) => error)
    const sent = page.frames().filter((frame) => frame.type === 'request')
    const id = sent.at(-1)?.type === 'request' ? sent.at(-1)?.id : undefined
    if (id === undefined) {
      throw new Error('no request went out')
    }
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'error',
      id,
      error: {
        category: 'BridgeNativeVerbRefusedError',
        code: 'native_verb_something_new',
        message: 'a verb from a later build',
        isRpcDeliveryUnknown: false
      }
    })
    const caught = await read
    expect(caught).toBeInstanceOf(NativeVerbError)
    expect(caught instanceof NativeVerbError && caught.reason).toBe('unreported')
  })
})

describe('what the surface offers a screen', () => {
  it('carries no capability flag with nothing behind it', async () => {
    const pair = createFakeBridgePortPair({})
    const verbs = await mount(pair)
    // Pinned so an unread flag has to be added here on purpose. `canCaptureAudio` was one: four
    // grants read and answered to nobody, where the fence that actually holds is the per-verb
    // `ungranted` check every member already makes before a frame is sent. A flag no screen reads
    // is a capability negotiation that exists only in this file.
    expect(Object.keys(verbs).sort()).toEqual([
      'canPickMedia',
      'canReadClipboardText',
      'canWriteClipboardText',
      'granted',
      'pickMedia',
      'readAudio',
      'readClipboardText',
      'readMedia',
      'releaseMedia',
      'setWakelock',
      'startAudio',
      'stopAudio',
      'writeClipboardText'
    ])
  })
})
