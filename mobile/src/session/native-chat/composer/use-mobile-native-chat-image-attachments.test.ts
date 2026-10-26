import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { buildAgentTuiClearInputForText } from '../../../../../src/shared/agent-tui-input-clear'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../../../transport/types'
import { resetMobileNativeChatStaleInputForTests } from '../mobile-native-chat-stale-input'
import { resetMobileNativeChatTerminalWritesForTests } from '../mobile-native-chat-terminal-write-lock'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'

// Stub the media seam so direct Expo imports would expose unsupported Flow syntax and fail the transform.
const pick = vi.hoisted(() => vi.fn())
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
function sendResult(accepted: boolean): RpcSuccess {
  return { id: 'send', ok: true, result: { send: { accepted } }, _meta: { runtimeId: 'r' } }
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

const textSend = (text: string, previews?: string[]) =>
  [text, previews, expect.any(Number), undefined, expect.any(Number)] as const

const SCOPE_A = 'h\0w\0tab-a'
const SCOPE_B = 'h\0w\0tab-b'

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

  function mount(args: HookArgs): void {
    act(() => {
      renderer = create(createElement(Harness, { args }))
    })
  }

  function update(args: HookArgs): void {
    act(() => {
      renderer!.update(createElement(Harness, { args }))
    })
  }

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

    expect(hook!.attachments).toEqual([
      {
        id: 'img-1',
        path: '/tmp/a.png',
        previewUri: 'file:///a.jpg'
      }
    ])
    expect(client.calls.some((c) => c.method === 'terminal.send')).toBe(false)
  })

  it.each(['claude', 'omp'])('rides %s images along before the text', async (agent) => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true),
      sendResult(true)
    ])
    const order: string[] = []
    const sleep = vi.fn(async () => {
      order.push('settle')
    })
    const baseSend = vi.fn(async (t: string) => {
      order.push(`text:${t}`)
      return 'accepted' as const
    })
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
    expect(sendCalls).toHaveLength(2)
    expect(sendCalls[0]?.params).toMatchObject({ text: '\x15', enter: false })
    expect(sendCalls[1]?.params).toMatchObject({
      text: `\x1b[200~${agent === 'omp' ? '@' : ''}/tmp/a.png\x1b[201~ `,
      enter: false
    })
    const combined = String(sendCalls[1]?.params.text ?? '') + 'look at this'
    expect(combined).toContain('.png\x1b[201~ look')
    expect(combined).not.toContain('.png\x1b[201~look')
    expect(order).toEqual(['clear', 'paste', 'settle', 'text:look at this'])
    expect(baseSend).toHaveBeenCalledWith(...textSend('look at this', ['file:///a.jpg']))
    expect(hook!.attachments).toEqual([])
  })

  it('leads the image paste with a clear sized to a parked multi-line launch draft', async () => {
    // One Ctrl+U clears only the final line; earlier launch context would join the image prompt.
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true),
      sendResult(true)
    ])
    const draft = 'Linked Linear issue: ABC-123\nhttps://linear.app/x/issue/ABC-123'
    mount(
      baseArgs({
        client: client as unknown as RpcClient,
        deviceTokenRef: { current: 'device-1' },
        readSeededLaunchDraft: () => draft
      })
    )

    await act(async () => {
      await hook!.attachImage('library')
    })
    await act(async () => {
      await hook!.sendNativeChat('look at this')
    })

    const firstSend = client.calls.find((c) => c.method === 'terminal.send')
    expect(firstSend?.params).toMatchObject({
      text: buildAgentTuiClearInputForText(draft),
      enter: false
    })
    expect(firstSend?.params.text).not.toBe('\x15')
  })

  it('spends one budget and one press time across the image paste and the text body', async () => {
    vi.useFakeTimers()
    try {
      pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
      const client = makeClient([
        methodNotFound('start'),
        ok('save', '/tmp/a.png'),
        sendResult(true),
        sendResult(true)
      ])
      const slowClient: Pick<RpcClient, 'sendRequest'> = {
        sendRequest: async (method, params) => {
          if (method === 'terminal.send') {
            // A slow relay: each write burns 5s of the action's budget.
            vi.setSystemTime(Date.now() + 5_000)
          }
          return client.sendRequest(method, params)
        }
      }
      const baseSend = vi.fn().mockResolvedValue('accepted')
      mount(baseArgs({ client: slowClient as RpcClient, baseSend }))

      await act(async () => {
        await hook!.attachImage('library')
      })
      const pressedAt = Date.now()
      await act(async () => {
        await hook!.sendNativeChat('look at this')
      })

      // The paste spends 10s of the shared 15s budget; text gets the remainder plus deliberate settle, not a fresh deadline.
      const deadline = baseSend.mock.calls[0]?.[2] as number
      expect(deadline - Date.now()).toBe(5_300)
      expect(baseSend.mock.calls[0]?.[4]).toBe(pressedAt)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', '   ']
  ])('routes an attachments-only send through baseSend with %s text', async (_label, text) => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true),
      sendResult(true)
    ])
    const baseSend = vi.fn().mockResolvedValue('accepted')
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend }))

    await act(async () => {
      await hook!.attachImage('library')
    })
    let accepted = false
    await act(async () => {
      accepted = await hook!.sendNativeChat(text)
    })

    expect(accepted).toBe(true)
    // Attachment-only sends still submit Enter through baseSend so their optimistic echoes carry previews.
    expect(baseSend).toHaveBeenCalledWith(...textSend(text, ['file:///a.jpg']))
    const sendCalls = client.calls.filter((c) => c.method === 'terminal.send')
    expect(sendCalls).toHaveLength(2)
    expect(sendCalls[1]?.params.text).toBe('\x1b[200~/tmp/a.png\x1b[201~')
    expect(hook!.attachments).toEqual([])
  })

  it('delegates straight to baseSend when there are no attachments', async () => {
    const client = makeClient([])
    const baseSend = vi.fn().mockResolvedValue('accepted')
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend }))

    await act(async () => {
      await hook!.sendNativeChat('just text')
    })
    expect(baseSend).toHaveBeenCalledWith(...textSend('just text'))
    expect(client.calls).toHaveLength(0)
  })

  it('keeps the chips and does not submit when the image paste is rejected', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true),
      sendResult(false)
    ])
    const baseSend = vi.fn().mockResolvedValue('accepted')
    const onSendError = vi.fn()
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend, onSendError }))
    await act(async () => {
      await hook!.attachImage('library')
    })
    let accepted = true
    await act(async () => {
      accepted = await hook!.sendNativeChat('hi')
    })
    expect(accepted).toBe(false)
    expect(baseSend).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
    expect(hook!.attachments).toHaveLength(1)
  })

  it('keeps the chips and reports failure when the paste transport throws', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([methodNotFound('start'), ok('save', '/tmp/a.png')])
    const baseSend = vi.fn().mockResolvedValue('accepted')
    const onSendError = vi.fn()
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend, onSendError }))
    await act(async () => {
      await hook!.attachImage('library')
    })
    let accepted = true
    await act(async () => {
      accepted = await hook!.sendNativeChat('hi')
    })
    expect(accepted).toBe(false)
    expect(baseSend).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
    expect(hook!.attachments).toHaveLength(1)
  })

  it('surfaces an error instead of a silent no-op when the input lease gate is closed', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([methodNotFound('start'), ok('save', '/tmp/a.png')])
    const baseSend = vi.fn().mockResolvedValue('accepted')
    const onSendError = vi.fn()
    mount(
      baseArgs({ client: client as unknown as RpcClient, enabled: false, baseSend, onSendError })
    )
    await act(async () => {
      await hook!.attachImage('library')
    })
    let accepted = true
    await act(async () => {
      accepted = await hook!.sendNativeChat('hi')
    })
    expect(accepted).toBe(false)
    expect(baseSend).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent (disconnected)')
    expect(hook!.attachments).toHaveLength(1)
  })

  it('scopes chips to the tab that attached them', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([methodNotFound('start'), ok('save', '/tmp/a.png')])
    const baseSend = vi.fn().mockResolvedValue('accepted')
    const args = baseArgs({ client: client as unknown as RpcClient, baseSend })
    mount(args)
    await act(async () => {
      await hook!.attachImage('library')
    })
    expect(hook!.attachments).toHaveLength(1)

    update({ ...args, scopeKey: 'h\0w\0tab-b' })
    expect(hook!.attachments).toEqual([])
    await act(async () => {
      await hook!.sendNativeChat('hi')
    })
    expect(baseSend).toHaveBeenCalledWith(...textSend('hi'))
    expect(client.calls.some((c) => c.method === 'terminal.send')).toBe(false)

    update(args)
    expect(hook!.attachments).toHaveLength(1)
  })

  it('keeps isAttaching true when a cancelled pick overlaps a genuine in-flight upload', async () => {
    // Hold a real upload after its counter increment; a concurrent cancelled pick must not decrement work it never started.
    let releaseConnection: ((id: string | null) => void) | null = null
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
    let firstAttach: Promise<void> | null = null
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

  it('clears only the chips that were sent, keeping one attached mid-send', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true),
      sendResult(true),
      methodNotFound('start'),
      ok('save', '/tmp/b.png')
    ])
    const baseSend = vi.fn().mockResolvedValue('accepted')
    let releaseSettle: (() => void) | null = null
    const args = baseArgs({
      client: client as unknown as RpcClient,
      baseSend,
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSettle = resolve
        })
    })
    mount(args)
    await act(async () => {
      await hook!.attachImage('library')
    })

    let sendPromise: Promise<boolean> | null = null
    await act(async () => {
      sendPromise = hook!.sendNativeChat('hi')
      for (let i = 0; i < 50 && !releaseSettle; i++) {
        await Promise.resolve()
      }
    })
    expect(releaseSettle).not.toBeNull()

    pick.mockResolvedValue([{ base64: 'BBBB', uri: 'file:///b.jpg' }])
    await act(async () => {
      await hook!.attachImage('library')
    })
    let overlappingAccepted = true
    await act(async () => {
      overlappingAccepted = await hook!.sendNativeChat('too soon')
    })
    expect(overlappingAccepted).toBe(false)
    expect(baseSend).not.toHaveBeenCalled()
    expect(client.calls.filter((call) => call.method === 'terminal.send')).toHaveLength(2)

    await act(async () => {
      releaseSettle!()
      await sendPromise
    })

    expect(baseSend).toHaveBeenCalledWith(...textSend('hi', ['file:///a.jpg']))
    expect(hook!.attachments.map((a) => a.previewUri)).toEqual(['file:///b.jpg'])
  })

  it('aborts the send when the active terminal changes during the settle window', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true),
      sendResult(true)
    ])
    const baseSend = vi.fn().mockResolvedValue('accepted')
    const onSendError = vi.fn()
    const activeHandleRef = { current: 'term-1' }
    let releaseSettle: (() => void) | null = null
    const args = baseArgs({
      client: client as unknown as RpcClient,
      activeHandleRef,
      baseSend,
      onSendError,
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSettle = resolve
        })
    })
    mount(args)
    await act(async () => {
      await hook!.attachImage('library')
    })

    let sendPromise: Promise<boolean> | null = null
    await act(async () => {
      sendPromise = hook!.sendNativeChat('hi')
      for (let i = 0; i < 50 && !releaseSettle; i++) {
        await Promise.resolve()
      }
    })
    expect(releaseSettle).not.toBeNull()
    // Tab switches during settle must not send text/Enter to a different terminal than the images.
    activeHandleRef.current = 'term-2'
    let accepted = true
    await act(async () => {
      releaseSettle!()
      accepted = await sendPromise!
    })
    expect(accepted).toBe(false)
    expect(baseSend).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
    expect(hook!.attachments).toHaveLength(1)
  })

  it('leads the next text-only send with Ctrl+U after a failed paste, even with the chip removed', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true),
      sendResult(false),
      sendResult(true)
    ])
    const baseSend = vi.fn().mockResolvedValue('accepted')
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend }))
    await act(async () => {
      await hook!.attachImage('library')
    })
    await act(async () => {
      await hook!.sendNativeChat('hi')
    })
    expect(baseSend).not.toHaveBeenCalled()

    await act(async () => {
      hook!.removeAttachment('img-1')
    })
    expect(hook!.attachments).toEqual([])
    let accepted = false
    await act(async () => {
      accepted = await hook!.sendNativeChat('hi again')
    })
    expect(accepted).toBe(true)
    const sendCalls = client.calls.filter((c) => c.method === 'terminal.send')
    expect(sendCalls).toHaveLength(3)
    expect(sendCalls[2]?.params).toMatchObject({ text: '\x15', enter: false })
    expect(baseSend).toHaveBeenCalledWith(...textSend('hi again'))
  })

  it('heals before the next text-only send when an image submit delivery is unknown (#10228)', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true),
      sendResult(true),
      sendResult(true)
    ])
    const baseSend = vi.fn().mockResolvedValueOnce('unknown').mockResolvedValueOnce('accepted')
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend }))
    await act(async () => {
      await hook!.attachImage('library')
    })

    // Ambiguous delivery: the paste landed but the text+Enter may not have.
    let accepted = false
    await act(async () => {
      accepted = await hook!.sendNativeChat('pic')
    })
    // Unknown delivery may have landed; clear chips so retry cannot duplicate photos.
    expect(accepted).toBe(true)
    expect(hook!.attachments).toEqual([])

    // Heal the next text send because lost Enter may have left the image path on the input line.
    await act(async () => {
      accepted = await hook!.sendNativeChat('later message')
    })
    expect(accepted).toBe(true)
    const sendCalls = client.calls.filter((c) => c.method === 'terminal.send')
    expect(sendCalls).toHaveLength(3)
    expect(sendCalls[2]?.params).toMatchObject({ text: '\x15', enter: false })
    expect(baseSend).toHaveBeenNthCalledWith(1, ...textSend('pic', ['file:///a.jpg']))
    expect(baseSend).toHaveBeenNthCalledWith(2, ...textSend('later message'))
  })

  it('still heals after the session screen unmounts and remounts (#10228)', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true),
      sendResult(true),
      sendResult(true)
    ])
    const baseSend = vi.fn().mockResolvedValueOnce('unknown').mockResolvedValueOnce('accepted')
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend }))
    await act(async () => {
      await hook!.attachImage('library')
    })
    await act(async () => {
      await hook!.sendNativeChat('pic')
    })

    // The stale paste belongs to host input and must remain marked across screen remounts.
    act(() => renderer!.unmount())
    renderer = null
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend }))
    expect(hook!.attachments).toEqual([])

    let accepted = false
    await act(async () => {
      accepted = await hook!.sendNativeChat('later message')
    })
    expect(accepted).toBe(true)
    const sendCalls = client.calls.filter((c) => c.method === 'terminal.send')
    expect(sendCalls).toHaveLength(3)
    expect(sendCalls[2]?.params).toMatchObject({ terminal: 'term-1', text: '\x15', enter: false })
    expect(baseSend).toHaveBeenNthCalledWith(2, ...textSend('later message'))
  })

  it('does not heal after an unknown text-only send (nothing was pasted first)', async () => {
    const client = makeClient([])
    const baseSend = vi.fn().mockResolvedValueOnce('unknown').mockResolvedValueOnce('accepted')
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend }))

    let accepted = false
    await act(async () => {
      accepted = await hook!.sendNativeChat('first')
    })
    expect(accepted).toBe(true)
    await act(async () => {
      accepted = await hook!.sendNativeChat('second')
    })
    expect(accepted).toBe(true)
    expect(client.calls).toHaveLength(0)
  })

  it('retains the stale marker when a rejected healing clear blocks text-only send', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true),
      sendResult(true),
      sendResult(false),
      sendResult(true)
    ])
    const baseSend = vi.fn().mockResolvedValueOnce('rejected').mockResolvedValueOnce('accepted')
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend }))
    await act(async () => {
      await hook!.attachImage('library')
    })
    await act(async () => {
      await hook!.sendNativeChat('hi')
    })
    expect(hook!.attachments).toHaveLength(1)

    await act(async () => {
      hook!.removeAttachment('img-1')
    })
    let accepted = true
    await act(async () => {
      accepted = await hook!.sendNativeChat('hi again')
    })
    expect(accepted).toBe(false)
    expect(baseSend).toHaveBeenCalledTimes(1)

    await act(async () => {
      accepted = await hook!.sendNativeChat('hi again')
    })
    expect(accepted).toBe(true)
    const sendCalls = client.calls.filter((c) => c.method === 'terminal.send')
    expect(sendCalls).toHaveLength(4)
    expect(sendCalls[2]?.params).toMatchObject({ text: '\x15', enter: false })
    expect(sendCalls[3]?.params).toMatchObject({ text: '\x15', enter: false })
    expect(baseSend).toHaveBeenNthCalledWith(1, ...textSend('hi', ['file:///a.jpg']))
    expect(baseSend).toHaveBeenNthCalledWith(2, ...textSend('hi again'))
  })

  it('does not reroute text when the active terminal changes during a healing clear', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    let releaseClear: ((response: RpcResponse) => void) | null = null
    const deferredClear = new Promise<RpcResponse>((resolve) => {
      releaseClear = resolve
    })
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true),
      sendResult(true),
      deferredClear
    ])
    const baseSend = vi.fn().mockResolvedValueOnce('rejected')
    const activeHandleRef = { current: 'term-1' }
    mount(baseArgs({ client: client as unknown as RpcClient, activeHandleRef, baseSend }))
    await act(async () => {
      await hook!.attachImage('library')
    })
    await act(async () => {
      await hook!.sendNativeChat('hi')
    })
    await act(async () => {
      hook!.removeAttachment('img-1')
    })

    let retry: Promise<boolean> | null = null
    await act(async () => {
      retry = hook!.sendNativeChat('hi again')
      await Promise.resolve()
    })
    activeHandleRef.current = 'term-2'
    let accepted = true
    await act(async () => {
      releaseClear!(sendResult(true))
      accepted = await retry!
    })

    expect(accepted).toBe(false)
    expect(baseSend).toHaveBeenCalledTimes(1)
    const sendCalls = client.calls.filter((c) => c.method === 'terminal.send')
    expect(sendCalls[2]?.params).toMatchObject({ terminal: 'term-1', text: '\x15', enter: false })
  })

  it('defers the heal instead of burning a rejected clear while the lease is closed', async () => {
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true),
      sendResult(true),
      sendResult(true)
    ])
    const baseSend = vi.fn().mockResolvedValueOnce('rejected').mockResolvedValueOnce('accepted')
    const onSendError = vi.fn()
    const args = baseArgs({ client: client as unknown as RpcClient, baseSend, onSendError })
    mount(args)
    await act(async () => {
      await hook!.attachImage('library')
    })
    await act(async () => {
      await hook!.sendNativeChat('hi')
    })
    await act(async () => {
      hook!.removeAttachment('img-1')
    })

    update({ ...args, enabled: false })
    let accepted = true
    await act(async () => {
      accepted = await hook!.sendNativeChat('hi again')
    })
    expect(accepted).toBe(false)
    expect(onSendError).toHaveBeenLastCalledWith('Message not sent (disconnected)')
    expect(client.calls.filter((c) => c.method === 'terminal.send')).toHaveLength(2)

    update({ ...args, enabled: true })
    await act(async () => {
      accepted = await hook!.sendNativeChat('hi again')
    })
    expect(accepted).toBe(true)
    const sendCalls = client.calls.filter((c) => c.method === 'terminal.send')
    expect(sendCalls).toHaveLength(3)
    expect(sendCalls[2]?.params).toMatchObject({ text: '\x15', enter: false })
  })

  it('heals rejected image submits independently across terminals', async () => {
    pick
      .mockResolvedValueOnce([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
      .mockResolvedValueOnce([{ base64: 'BBBB', uri: 'file:///b.jpg' }])
    const client = makeClient([
      methodNotFound('start-a'),
      ok('save-a', '/tmp/a.png'),
      sendResult(true),
      sendResult(true),
      methodNotFound('start-b'),
      ok('save-b', '/tmp/b.png'),
      sendResult(true),
      sendResult(true),
      sendResult(true),
      sendResult(true)
    ])
    const baseSend = vi
      .fn()
      .mockResolvedValueOnce('rejected')
      .mockResolvedValueOnce('rejected')
      .mockResolvedValueOnce('accepted')
      .mockResolvedValueOnce('accepted')
    const activeHandleRef = { current: 'term-1' }
    const args = baseArgs({ client: client as unknown as RpcClient, activeHandleRef, baseSend })
    mount(args)
    await act(async () => {
      await hook!.attachImage('library')
    })
    await act(async () => {
      await hook!.sendNativeChat('first')
    })

    activeHandleRef.current = 'term-2'
    update({ ...args, scopeKey: SCOPE_B })
    await act(async () => {
      await hook!.attachImage('library')
    })
    await act(async () => {
      await hook!.sendNativeChat('second')
    })
    await act(async () => {
      hook!.removeAttachment('img-2')
    })

    activeHandleRef.current = 'term-1'
    update(args)
    await act(async () => {
      hook!.removeAttachment('img-1')
    })
    await act(async () => {
      expect(await hook!.sendNativeChat('retry first')).toBe(true)
    })

    activeHandleRef.current = 'term-2'
    update({ ...args, scopeKey: SCOPE_B })
    await act(async () => {
      expect(await hook!.sendNativeChat('retry second')).toBe(true)
    })

    const sendCalls = client.calls.filter((c) => c.method === 'terminal.send')
    expect(sendCalls.slice(4).map((call) => call.params)).toMatchObject([
      { terminal: 'term-1', text: '\x15', enter: false },
      { terminal: 'term-2', text: '\x15', enter: false }
    ])
    expect(baseSend).toHaveBeenCalledTimes(4)
  })

  it('reports a disconnected attach failure via the live connection state', async () => {
    const client = makeClient([])
    const showToast = vi.fn()
    let failUpload: ((error: Error) => void) | null = null
    const args = baseArgs({
      client: client as unknown as RpcClient,
      showToast,
      getActiveWorktreeConnectionId: () =>
        new Promise<string | null>((_resolve, reject) => {
          failUpload = reject
        })
    })
    mount(args)
    pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
    let attach: Promise<void> | null = null
    await act(async () => {
      attach = hook!.attachImage('library')
      for (let i = 0; i < 50 && !failUpload; i++) {
        await Promise.resolve()
      }
    })
    expect(failUpload).not.toBeNull()
    // The connection drops mid-upload, then the in-flight RPC fails. The closure
    // captured 'connected' at call time — only a live read can toast accurately.
    update({ ...args, connState: 'connecting' })
    await act(async () => {
      failUpload!(new Error('socket closed'))
      await attach
    })
    expect(showToast).toHaveBeenCalledWith('Attach failed (disconnected)', 1500)
  })
})
