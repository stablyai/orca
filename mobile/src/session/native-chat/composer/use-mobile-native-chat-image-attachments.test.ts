import { closeMobileNativeChatEditInputs } from './mobile-native-chat-draft-inputs'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import '../../../../../src/shared/agent-launch/startup/agent-tui-input-clear'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { RpcResponse, RpcSuccess } from '../../../transport/rpc/rpc-wire-types'
import { resetMobileNativeChatStaleInputForTests } from './mobile-native-chat-stale-input'
import { resetMobileNativeChatTerminalWritesForTests } from './mobile-native-chat-terminal-write-lock'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'

// Stub the media seam so direct Expo imports would expose unsupported Flow syntax and fail the transform.
const pick = vi.hoisted(() => vi.fn())
const ids = vi.hoisted(() => ({ next: 0 }))
vi.mock('../../../../../src/shared/non-secure-context-uuid', () => ({
  createNonSecureContextUuid: () => `img-${++ids.next}`
}))
vi.mock('../../../platform/media-picker', () => ({ useMediaPicker: () => ({ pickImages: pick }) }))

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

function makeClient(responses: (RpcResponse | Promise<RpcResponse>)[]): Pick<
  RpcClient,
  'sendRequest'
> & {
  calls: { method: string; params: Record<string, unknown> }[]
} {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  return {
    calls,
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      if (method === 'terminal.read') {
        return ok('read', {})
      }
      calls.push({ method, params: params as Record<string, unknown> })
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

describe('useMobileNativeChatImageAttachments', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null
  let releaseConnection: ((id: string | null) => void) | null = null
  let firstAttach: Promise<void> | null = null

  function Harness({ args }: { args: HookArgs }): null {
    hook = useMobileNativeChatImageAttachments(args)
    return null
  }

  beforeEach(() => {
    ids.next = 0
    pick.mockReset()
    resetMobileNativeChatStaleInputForTests()
    resetMobileNativeChatTerminalWritesForTests()
  })
  afterEach(async () => {
    act(() => renderer?.unmount())
    closeMobileNativeChatEditInputs(SCOPE_A)
    await act(async () => {
      releaseConnection?.(null)
      await firstAttach
    })
    releaseConnection = null
    firstAttach = null
    renderer = null
    hook = null
  })

  function mount(args: HookArgs): void {
    act(() => {
      renderer = create(createElement(Harness, { args }))
    })
  }

  it('keeps isAttaching true when a cancelled pick overlaps a genuine in-flight upload', async () => {
    // Hold a real upload after its counter increment; a concurrent cancelled pick must not decrement work it never started.
    const client = makeClient([methodNotFound('start'), ok('save', '/tmp/a.png')])
    const args = baseArgs({
      client: client as unknown as RpcClient,
      getActiveWorktreeConnectionId: () =>
        new Promise<string | null>((resolve) => {
          releaseConnection = resolve
        })
    })
    mount(args)

    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    await act(async () => {
      firstAttach = hook!.attachImage('library')
      for (let i = 0; i < 50 && !releaseConnection; i++) {
        await Promise.resolve()
      }
    })
    expect(releaseConnection).not.toBeNull()
    expect(hook!.isAttaching).toBe(true)

    pick.mockResolvedValue([])
    await act(async () => {
      await hook!.attachImage('library')
    })
    expect(hook!.isAttaching).toBe(true)

    await act(async () => {
      releaseConnection!('conn-1')
      await firstAttach
    })
    expect(hook!.isAttaching).toBe(false)
    expect(hook!.attachments).toHaveLength(1)
  })
})
