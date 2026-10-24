import {
  hydrateMobileNativeChatDraft,
  resetMobileNativeChatDraftStoreForTests
} from './mobile-native-chat-draft-store'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import { resetMobileNativeChatStaleInputForTests } from './mobile-native-chat-stale-input'
import { resetMobileNativeChatTerminalWritesForTests } from './mobile-native-chat-terminal-write-lock'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'

// Stubbed at the seam the hook now holds, which keeps the real expo/react-native chain out of the
// vitest transform (react-native ships Flow syntax rolldown cannot parse) and pins the call site:
// a hook that went back to importing the picker module directly would load that chain and fail.
const pick = vi.hoisted(() => vi.fn())
vi.mock('../platform/media-picker', () => ({ useMediaPicker: () => ({ pickImages: pick }) }))

function ok(id: string, result: unknown): RpcSuccess {
  return { id, ok: true, result, _meta: { runtimeId: 'r' } }
}
function methodNotFound(id: string): RpcResponse {
  return {
    id,
    ok: false,
    error: { code: 'method_not_found', message: 'no' },
    _meta: { runtimeId: 'r' }
  }
}
function makeClient(responses: (RpcResponse | Promise<RpcResponse>)[]): RpcClient & {
  calls: { method: string; params: unknown }[]
} {
  const calls: { method: string; params: unknown }[] = []
  return {
    calls,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {},
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      const response = responses.shift()
      if (!response) {
        throw new Error(`unexpected request: ${method}`)
      }
      return response
    })
  }
}

type HookArgs = Parameters<typeof useMobileNativeChatImageAttachments>[0]
type Hook = ReturnType<typeof useMobileNativeChatImageAttachments>

const SCOPE_A = 'h\0w\0tab-a'

function baseArgs(overrides: Partial<HookArgs> & Pick<HookArgs, 'client'>): HookArgs {
  return {
    agent: 'claude',
    activeHandleRef: { current: 'term-1' },
    deviceTokenRef: { current: null },
    getActiveWorktreeConnectionId: async () => null,
    connState: 'connected',
    scopeKey: SCOPE_A,
    enabled: true,
    structuredNativeChat: false,
    showToast: vi.fn(),
    onSendError: vi.fn(),
    baseSend: vi.fn().mockResolvedValue('accepted'),
    readSeededLaunchDraft: () => null,
    sleep: async () => {},
    ...overrides
  }
}

describe('native chat image upload feedback', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null

  function Harness({ args }: { args: HookArgs }): null {
    hook = useMobileNativeChatImageAttachments(args)
    return null
  }

  beforeEach(() => {
    pick.mockReset()
    resetMobileNativeChatDraftStoreForTests()
    // Stale markers and write locks live at module scope (they outlive the
    // screen), so they also outlive a test.
    resetMobileNativeChatStaleInputForTests()
    resetMobileNativeChatTerminalWritesForTests()
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
  })

  function mount(args: HookArgs): void {
    if (args.scopeKey) {
      void hydrateMobileNativeChatDraft(args.scopeKey)
    }
    act(() => {
      renderer = create(createElement(Harness, { args }))
    })
  }

  it('settles partial composer photos before success then error feedback', async () => {
    pick.mockResolvedValue([
      { base64: 'AAAA', uri: 'file:///a.jpg' },
      { base64: 'invalid!', uri: 'file:///b.jpg' }
    ])
    const client = makeClient([methodNotFound('start'), ok('save', '/tmp/a.png')])
    const order: string[] = []
    const feedback = (kind: string) => {
      order.push(kind)
    }
    mount(
      baseArgs({
        client,
        onAttachSuccess: () => feedback('success'),
        onError: () => feedback('error'),
        showToast: () => feedback('toast')
      })
    )
    await act(async () => hook!.attachImage('library'))
    expect(hook!.attachments).toEqual([expect.objectContaining({ path: '/tmp/a.png' })])
    expect(hook!.isAttaching).toBe(false)
    expect(order).toEqual(['success', 'error', 'toast'])
  })
})
