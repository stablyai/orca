import type { ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Avoid Expo imports through re-exported screen hooks; this test calls none of them.
vi.mock('../../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
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

const mounted: ReactTestRenderer[] = []

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
    mounted.push(create(render(pair)))
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
  act(() => {
    for (const tree of mounted.splice(0)) {
      tree.unmount()
    }
  })
  vi.useRealTimers()
})

describe('a page calling a native verb', () => {
  it('writes through the shell and hears whether the pasteboard took it', async () => {
    const serveNativeVerb = vi.fn(async () => ({ written: true }))
    const pair = createFakeBridgePortPair({ serveNativeVerb })
    const verbs = await mount(pair)
    expect(verbs.granted).toBe(true)
    const written = verbs.writeClipboardText('copied')
    await pair.flush()
    await expect(written).resolves.toBe(true)
    expect(serveNativeVerb).toHaveBeenCalledWith('native.clipboard.write', {
      mime: 'text',
      value: 'copied'
    })
    expect(pair.rpc.requests).toEqual([])
  })

  it('reads through the shell', async () => {
    const serveNativeVerb = vi.fn(async () => ({ value: 'pasteboard' }))
    const pair = createFakeBridgePortPair({ serveNativeVerb })
    const verbs = await mount(pair)
    const read = verbs.readClipboardText()
    await pair.flush()
    await expect(read).resolves.toBe('pasteboard')
    expect(serveNativeVerb).toHaveBeenCalledWith('native.clipboard.read', { mime: 'text' })
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
    // Inspect the wire to distinguish local refusal from an otherwise identical rejected round trip.
    expect(page.sent).toHaveLength(before)
  })
})

// The typed member must reject desktop methods too; widened callers could otherwise bypass the raw-port inventory’s call shapes.
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

// Preserve one typed refusal with a stable code; callers must not distinguish recovery actions by message text.
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
    // Model only the handler’s code property; importing its real class would load React Native into this test.
    const declined = Object.assign(new Error('image is not served by this build'), {
      code: 'native_verb_out_of_scope'
    })
    const error = await rejectionFrom(() => Promise.reject(declined))
    expect(error.reason).toBe('native_verb_out_of_scope')
    // Handler messages remain on-device because failed reads may contain the data they read.
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
    for (const reason of reasons) {
      expect(NATIVE_VERB_REASONS, reason).toContain(reason)
      expect(reason).not.toBe('unreported')
    }
    expect(reasons).toEqual(['native_verb_failed', 'reply-too-large', 'native_verb_result'])
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
    // Inject a newer-shell code directly; this host normalizes unknown codes before sending, so the pair cannot produce it itself.
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
