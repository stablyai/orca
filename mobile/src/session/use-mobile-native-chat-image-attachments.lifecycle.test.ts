import {
  deleteMobileNativeChatDrafts,
  hydrateMobileNativeChatDraft,
  readMobileNativeChatDraft,
  resetMobileNativeChatDraftStoreForTests
} from './mobile-native-chat-draft-store'
import { publishMobileChatDraftStorage } from './mobile-native-chat-draft-storage'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
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

/** A terminal chat's text send: its words, preview URIs, the action's budget, no attachments, and
 *  when Send was pressed. */

function sendResult(accepted: boolean): RpcSuccess {
  return { id: 'send', ok: true, result: { send: { accepted } }, _meta: { runtimeId: 'r' } }
}
const textSend = (text: string, previews?: string[]) =>
  [text, previews, expect.any(Number), undefined, expect.any(Number)] as const

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

describe('useMobileNativeChatImageAttachments lifecycle', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null

  function Harness({ args }: { args: HookArgs }): null {
    hook = useMobileNativeChatImageAttachments(args)
    return null
  }

  beforeEach(() => {
    pick.mockReset()
    // Stale markers and write locks live at module scope (they outlive the
    // screen), so they also outlive a test.
    resetMobileNativeChatDraftStoreForTests()
    resetMobileNativeChatStaleInputForTests()
    resetMobileNativeChatTerminalWritesForTests()
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    publishMobileChatDraftStorage(null)
  })

  function mount(args: HookArgs): void {
    if (args.scopeKey) {
      void hydrateMobileNativeChatDraft(args.scopeKey)
    }
    act(() => {
      renderer = create(createElement(Harness, { args }))
    })
  }

  it.each(['recreated', 'replaced'] as const)(
    'rejects a retired upload with one failure after the draft is %s',
    async (retirement) => {
      let release = (_items: { base64: string; uri: string }[]) => {}
      pick.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
      const client = makeClient([methodNotFound('start'), ok('save', '/tmp/retired.png')])
      const showToast = vi.fn()
      const onAttachSuccess = vi.fn()
      const onError = vi.fn()
      mount(
        baseArgs({
          client: { ...createFakeRpcClient(), sendRequest: client.sendRequest },
          showToast,
          onAttachSuccess,
          onError
        })
      )
      let attaching: Promise<void>
      await act(async () => {
        attaching = hook!.attachImage('library')
        await Promise.resolve()
      })
      await act(async () => {
        if (retirement === 'recreated') {
          await deleteMobileNativeChatDrafts('h', 'w')
        } else {
          publishMobileChatDraftStorage({
            read: async () => null,
            write: async () => {},
            removeWorkspace: async () => {}
          })
        }
        await hydrateMobileNativeChatDraft(SCOPE_A)
      })
      await act(async () => {
        release([{ base64: 'AAAA', uri: 'file:///old.jpg' }])
        await attaching!
      })
      expect(readMobileNativeChatDraft(SCOPE_A).images).toEqual([])
      expect(showToast).toHaveBeenCalledExactlyOnceWith('Attach failed', 1500)
      expect(onError).toHaveBeenCalledOnce()
      expect(onAttachSuccess).not.toHaveBeenCalled()
    }
  )

  it('adds an uploaded image as a chip without pasting to the terminal', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([methodNotFound('start'), ok('save', '/tmp/a.png')])
    mount(
      baseArgs({
        client: client as unknown as RpcClient,
        deviceTokenRef: { current: 'device-1' },
        getActiveWorktreeConnectionId: async () => 'conn-1'
      })
    )

    await act(async () => {
      await hook!.attachImage('library')
    })

    expect(hook!.attachments.map(({ path }) => path)).toEqual(['/tmp/a.png'])
    expect(hook!.attachments[0]?.previewUri).toBe('file:///a.jpg')
    expect(client.calls.some((c) => c.method === 'terminal.send')).toBe(false)
  })

  it.each(['claude', 'omp'])('rides %s images along before the text', async (agent) => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true), // Ctrl+U clear
      sendResult(true) // the image paste (enter:false)
    ])
    const order: string[] = []
    const sleep = vi.fn(async () => {
      order.push('settle')
    })
    const baseSend = vi.fn(async (t: string) => {
      order.push(`text:${t}`)
      return 'accepted' as const
    })
    // Record each terminal write so the paste-before-settle order is asserted,
    // not just implied by the call counts.
    const trackedClient: Pick<RpcClient, 'sendRequest'> = {
      sendRequest: (method, params) => {
        if (method === 'terminal.send') {
          order.push((params as { text?: string }).text === '\x15' ? 'clear' : 'paste')
        }
        return client.sendRequest(method, params)
      }
    }
    mount(
      baseArgs({
        client: trackedClient as RpcClient,
        agent,
        deviceTokenRef: { current: 'device-1' },
        baseSend,
        sleep
      })
    )

    await act(async () => {
      await hook!.attachImage('library')
    })

    let accepted = false
    await act(async () => {
      accepted = await hook!.sendNativeChat('look at this')
    })

    expect(accepted).toBe(true)
    const sendCalls = client.calls.filter((c) => c.method === 'terminal.send')
    // Ctrl+U clear, then the bracketed image paste.
    expect(sendCalls).toHaveLength(2)
    expect(sendCalls[0]?.params).toMatchObject({ text: '\x15', enter: false })
    expect(sendCalls[1]?.params).toMatchObject({
      text: `\x1b[200~${agent === 'omp' ? '@' : ''}/tmp/a.png\x1b[201~ `,
      enter: false
    })
    const combined = `${String(sendCalls[1]?.params.text ?? '')}look at this`
    expect(combined).toContain('.png\x1b[201~ look')
    expect(combined).not.toContain('.png\x1b[201~look')
    // Clear, then paste, then settle, then the text send — in that order.
    expect(order).toEqual(['clear', 'paste', 'settle', 'text:look at this'])
    // The local preview URI rides along so the sent bubble shows the photo.
    expect(baseSend).toHaveBeenCalledWith(...textSend('look at this', ['file:///a.jpg']))
    // Chips clear once the send is accepted.
    expect(hook!.attachments).toEqual([])
  })
})
