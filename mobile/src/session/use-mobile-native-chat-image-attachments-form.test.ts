import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import { resetMobileNativeChatStaleInputForTests } from './mobile-native-chat-stale-input'
import { resetMobileNativeChatTerminalWritesForTests } from './mobile-native-chat-terminal-write-lock'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'

// Fully stub the picker so the real expo/react-native chain never loads under
// the vitest transform (react-native ships Flow syntax rolldown can't parse).
vi.mock('./mobile-image-source-picker', () => ({
  pickMobileImages: vi.fn(),
  ImageLibraryPermissionError: class ImageLibraryPermissionError extends Error {}
}))

import { pickMobileImages } from './mobile-image-source-picker'

const pick = vi.mocked(pickMobileImages)

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
function sendResult(): RpcSuccess {
  return { id: 'send', ok: true, result: { send: { accepted: true } }, _meta: { runtimeId: 'r' } }
}

function makeClient(responses: RpcResponse[]): Pick<RpcClient, 'sendRequest'> & {
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

describe('the attachment form the native chat composer writes', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null

  function Harness({ args }: { args: HookArgs }): null {
    hook = useMobileNativeChatImageAttachments(args)
    return null
  }

  beforeEach(() => {
    pick.mockReset()
    resetMobileNativeChatStaleInputForTests()
    resetMobileNativeChatTerminalWritesForTests()
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
  })

  it.each([
    ['claude', '\x1b[200~/tmp/a.png\x1b[201~ '],
    // OMP wraps Pi's TUI: no verified image-paste gesture, so it gets `@path`.
    ['omp', '@/tmp/a.png ']
  ])('writes the %s form for the agent on the tab it is sending to', async (agent, expected) => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(), // Ctrl+U clear
      sendResult() // the attachment write
    ])
    const args: HookArgs = {
      client: client as unknown as RpcClient,
      activeHandleRef: { current: 'term-1' },
      agentRef: { current: agent },
      deviceTokenRef: { current: null },
      getActiveWorktreeConnectionId: async () => null,
      connState: 'connected',
      scopeKey: 'h\0w\0tab-a',
      enabled: true,
      showToast: vi.fn(),
      onSendError: vi.fn(),
      baseSend: vi.fn().mockResolvedValue('accepted'),
      // The terminal paste path under test — a structured session attaches without it.
      structuredNativeChat: false,
      readSeededLaunchDraft: () => null,
      sleep: async () => {}
    }
    act(() => {
      renderer = create(createElement(Harness, { args }))
    })

    await act(async () => {
      await hook!.attachImage('library')
    })
    await act(async () => {
      expect(await hook!.sendNativeChat('look at this')).toBe(true)
    })

    const sendCalls = client.calls.filter((call) => call.method === 'terminal.send')
    expect(sendCalls[1]?.params).toMatchObject({ text: expected, enter: false })
  })
})
