import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Avoid Expo imports through re-exported screen hooks; this test calls none of them.
vi.mock('../../transport/connection/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { RpcClientProvider } from '../../transport/connection/client-context.web'
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import { BRIDGE_NATIVE_VERB_NAMES } from './bridge-native-verbs'
import './bridge-port-pair-test-harness'
import { GRANTS, INIT, createPageClient } from './bridge-page-client-test-harness'
import { NativeVerbError, useNativeVerbs, type NativeVerbs } from './use-native-verbs'

const mounted: ReactTestRenderer[] = []

const held: { verbs: NativeVerbs | null } = { verbs: null }

function Screen(): null {
  held.verbs = useNativeVerbs()
  return null
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

// The typed member must reject desktop methods too; widened callers could otherwise bypass the raw-port inventory’s call shapes.

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
