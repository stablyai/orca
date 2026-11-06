import { resetMobileNativeChatDraftInputsForTests } from './mobile-native-chat-draft-inputs'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../../src/shared/agent-launch/startup/agent-tui-input-clear'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc-client'
import type { RpcResponse } from '../../../transport/types'
import { resetMobileNativeChatStaleInputForTests } from '../mobile-native-chat-stale-input'
import { resetMobileNativeChatTerminalWritesForTests } from '../mobile-native-chat-terminal-write-lock'
import {
  makeClient,
  methodNotFound,
  ok,
  sendResult
} from './mobile-native-chat-image-attachment-test-client'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'

// Stub the media seam so direct Expo imports would expose unsupported Flow syntax and fail the transform.
const pick = vi.hoisted(() => vi.fn())
const ids = vi.hoisted(() => ({ next: 0 }))
vi.mock('../../../../../src/shared/non-secure-context-uuid', () => ({
  createNonSecureContextUuid: () => `img-${++ids.next}`
}))
vi.mock('../../../platform/media-picker', () => ({ useMediaPicker: () => ({ pickImages: pick }) }))

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
    resetMobileNativeChatDraftInputsForTests()
    ids.next = 0
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

  it('passes the Hermes startup budget through to the text send', async () => {
    vi.useFakeTimers()
    try {
      const client = makeClient([])
      const baseSend = vi.fn().mockResolvedValue('accepted')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only calls the mocked sendRequest member.
      mount(baseArgs({ client: client as unknown as RpcClient, agent: 'hermes', baseSend }))
      const pressedAt = Date.now()
      await act(async () => {
        await hook!.sendNativeChat('hello')
      })
      expect(baseSend.mock.calls[0]?.[2]).toBe(pressedAt + 75_000)
    } finally {
      vi.useRealTimers()
    }
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
    expect(sendCalls[2]?.params).toMatchObject({ text: AGENT_TUI_CLEAR_INPUT_MAX, enter: false })
    expect(baseSend).toHaveBeenCalledWith(...textSend('hi again'))
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
    expect(sendCalls[2]?.params).toMatchObject({
      terminal: 'term-1',
      text: AGENT_TUI_CLEAR_INPUT_MAX,
      enter: false
    })
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
    expect(sendCalls[2]?.params).toMatchObject({ text: AGENT_TUI_CLEAR_INPUT_MAX, enter: false })
    expect(sendCalls[3]?.params).toMatchObject({ text: AGENT_TUI_CLEAR_INPUT_MAX, enter: false })
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
    expect(sendCalls[2]?.params).toMatchObject({
      terminal: 'term-1',
      text: AGENT_TUI_CLEAR_INPUT_MAX,
      enter: false
    })
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
    expect(sendCalls[2]?.params).toMatchObject({ text: AGENT_TUI_CLEAR_INPUT_MAX, enter: false })
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
      { terminal: 'term-1', text: AGENT_TUI_CLEAR_INPUT_MAX, enter: false },
      { terminal: 'term-2', text: AGENT_TUI_CLEAR_INPUT_MAX, enter: false }
    ])
    expect(baseSend).toHaveBeenCalledTimes(4)
  })
})
