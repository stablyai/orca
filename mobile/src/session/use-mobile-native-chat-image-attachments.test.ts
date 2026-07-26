import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'

// Fully stub the picker so the real expo/react-native chain never loads under
// the vitest transform (react-native ships Flow syntax rolldown can't parse).
vi.mock('./mobile-image-source-picker', () => ({
  pickMobileImage: vi.fn(),
  ImageLibraryPermissionError: class ImageLibraryPermissionError extends Error {}
}))

import { pickMobileImage } from './mobile-image-source-picker'

const pick = vi.mocked(pickMobileImage)

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

const SCOPE_A = 'h\0w\0tab-a'
const SCOPE_B = 'h\0w\0tab-b'

function baseArgs(overrides: Partial<HookArgs> & Pick<HookArgs, 'client'>): HookArgs {
  return {
    activeHandleRef: { current: 'term-1' },
    deviceTokenRef: { current: null },
    getActiveWorktreeConnectionId: async () => null,
    connState: 'connected',
    scopeKey: SCOPE_A,
    enabled: true,
    showToast: vi.fn(),
    baseSend: vi.fn().mockResolvedValue(true),
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
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    pick.mockReset()
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
  })

  function mount(args: HookArgs): void {
    const original = console.error
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      if (typeof a[0] === 'string' && a[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...a)
    })
    try {
      act(() => {
        renderer = create(createElement(Harness, { args }))
      })
    } finally {
      spy.mockRestore()
    }
  }

  function update(args: HookArgs): void {
    act(() => {
      renderer!.update(createElement(Harness, { args }))
    })
  }

  it('adds an uploaded image as a chip without pasting to the terminal', async () => {
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
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
      { id: 'img-1', path: '/tmp/a.png', previewUri: 'file:///a.jpg' }
    ])
    expect(client.calls.some((c) => c.method === 'terminal.send')).toBe(false)
  })

  it('rides pending images along on send: pastes the path, settles, then delegates the text', async () => {
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
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
      return true
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
      text: '\x1b[200~/tmp/a.png\x1b[201~',
      enter: false
    })
    // Clear, then paste, then settle, then the text send — in that order.
    expect(order).toEqual(['clear', 'paste', 'settle', 'text:look at this'])
    // The local preview URI rides along so the sent bubble shows the photo.
    expect(baseSend).toHaveBeenCalledWith('look at this', ['file:///a.jpg'])
    // Chips clear once the send is accepted.
    expect(hook!.attachments).toEqual([])
  })

  it('routes an attachments-only send through baseSend with empty text so the echo still shows the photo', async () => {
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true), // Ctrl+U clear
      sendResult(true) // image paste
    ])
    const baseSend = vi.fn().mockResolvedValue(true)
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend }))

    await act(async () => {
      await hook!.attachImage('library')
    })
    let accepted = false
    await act(async () => {
      accepted = await hook!.sendNativeChat('')
    })

    expect(accepted).toBe(true)
    // Empty text still goes through baseSend (which submits the bare Enter) so the
    // optimistic echo carries the preview URI.
    expect(baseSend).toHaveBeenCalledWith('', ['file:///a.jpg'])
    const sendCalls = client.calls.filter((c) => c.method === 'terminal.send')
    // Only the clear + image paste hit the wire here; baseSend owns the submit.
    expect(sendCalls).toHaveLength(2)
    expect(hook!.attachments).toEqual([])
  })

  it('delegates straight to baseSend when there are no attachments', async () => {
    const client = makeClient([])
    const baseSend = vi.fn().mockResolvedValue(true)
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend }))

    await act(async () => {
      await hook!.sendNativeChat('just text')
    })
    expect(baseSend).toHaveBeenCalledWith('just text')
    expect(client.calls).toHaveLength(0)
  })

  it('keeps the chips and does not submit when the image paste is rejected', async () => {
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true), // Ctrl+U clear
      sendResult(false) // image paste rejected
    ])
    const baseSend = vi.fn().mockResolvedValue(true)
    const showToast = vi.fn()
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend, showToast }))
    await act(async () => {
      await hook!.attachImage('library')
    })
    let accepted = true
    await act(async () => {
      accepted = await hook!.sendNativeChat('hi')
    })
    expect(accepted).toBe(false)
    expect(baseSend).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Message not sent', 1500)
    expect(hook!.attachments).toHaveLength(1)
  })

  it('keeps the chips and reports failure when the paste transport throws', async () => {
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
    // No terminal.send responses queued: the clear write throws (dropped transport).
    const client = makeClient([methodNotFound('start'), ok('save', '/tmp/a.png')])
    const baseSend = vi.fn().mockResolvedValue(true)
    const showToast = vi.fn()
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend, showToast }))
    await act(async () => {
      await hook!.attachImage('library')
    })
    let accepted = true
    await act(async () => {
      accepted = await hook!.sendNativeChat('hi')
    })
    expect(accepted).toBe(false)
    expect(baseSend).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Message not sent', 1500)
    expect(hook!.attachments).toHaveLength(1)
  })

  it('surfaces a toast instead of a silent no-op when the input lease gate is closed', async () => {
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
    const client = makeClient([methodNotFound('start'), ok('save', '/tmp/a.png')])
    const baseSend = vi.fn().mockResolvedValue(true)
    const showToast = vi.fn()
    // Attaching is allowed without the lease; only the send is gated on it.
    mount(baseArgs({ client: client as unknown as RpcClient, enabled: false, baseSend, showToast }))
    await act(async () => {
      await hook!.attachImage('library')
    })
    let accepted = true
    await act(async () => {
      accepted = await hook!.sendNativeChat('hi')
    })
    expect(accepted).toBe(false)
    expect(baseSend).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Message not sent (disconnected)', 1500)
    expect(hook!.attachments).toHaveLength(1)
  })

  it('scopes chips to the tab that attached them', async () => {
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
    const client = makeClient([methodNotFound('start'), ok('save', '/tmp/a.png')])
    const baseSend = vi.fn().mockResolvedValue(true)
    const args = baseArgs({ client: client as unknown as RpcClient, baseSend })
    mount(args)
    await act(async () => {
      await hook!.attachImage('library')
    })
    expect(hook!.attachments).toHaveLength(1)

    // Another tab sees no chip, and a send there is plain text — no image paste.
    update({ ...args, scopeKey: 'h\0w\0tab-b' })
    expect(hook!.attachments).toEqual([])
    await act(async () => {
      await hook!.sendNativeChat('hi')
    })
    expect(baseSend).toHaveBeenCalledWith('hi')
    expect(client.calls.some((c) => c.method === 'terminal.send')).toBe(false)

    // Back on the original tab the chip is still pending.
    update(args)
    expect(hook!.attachments).toHaveLength(1)
  })

  it('keeps isAttaching true when a cancelled pick overlaps a genuine in-flight upload', async () => {
    // Park a real upload right after onUploadStart (count -> 1, isAttaching true)
    // by holding its getConnectionId, then fire a cancelled pick. The cancelled
    // call never incremented, so its finally must not drop the shared counter.
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

    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
    let firstAttach: Promise<void> | null = null
    await act(async () => {
      firstAttach = hook!.attachImage('library')
      for (let i = 0; i < 50 && !releaseConnection; i++) {
        await Promise.resolve()
      }
    })
    expect(releaseConnection).not.toBeNull()
    expect(hook!.isAttaching).toBe(true)

    // A concurrent cancelled pick — its finally must leave the counter alone.
    pick.mockResolvedValue(null)
    await act(async () => {
      await hook!.attachImage('library')
    })
    expect(hook!.isAttaching).toBe(true)

    // The real upload finishes and clears the flag on its own.
    await act(async () => {
      releaseConnection!('conn-1')
      await firstAttach
    })
    expect(hook!.isAttaching).toBe(false)
    expect(hook!.attachments).toHaveLength(1)
  })

  it('clears only the chips that were sent, keeping one attached mid-send', async () => {
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'), // first attach
      sendResult(true), // Ctrl+U clear
      sendResult(true), // first image paste
      methodNotFound('start'),
      ok('save', '/tmp/b.png') // second attach, while the send is parked on settle
    ])
    const baseSend = vi.fn().mockResolvedValue(true)
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
      // Drain microtasks until the send parks on the settle sleep.
      for (let i = 0; i < 50 && !releaseSettle; i++) {
        await Promise.resolve()
      }
    })
    expect(releaseSettle).not.toBeNull()

    pick.mockResolvedValue({ base64: 'BBBB', uri: 'file:///b.jpg' })
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

    // Only the first (sent) image rode along; the mid-send chip survives.
    expect(baseSend).toHaveBeenCalledWith('hi', ['file:///a.jpg'])
    expect(hook!.attachments.map((a) => a.previewUri)).toEqual(['file:///b.jpg'])
  })

  it('aborts the send when the active terminal changes during the settle window', async () => {
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true), // Ctrl+U clear
      sendResult(true) // image paste — into term-1
    ])
    const baseSend = vi.fn().mockResolvedValue(true)
    const showToast = vi.fn()
    const activeHandleRef = { current: 'term-1' }
    let releaseSettle: (() => void) | null = null
    const args = baseArgs({
      client: client as unknown as RpcClient,
      activeHandleRef,
      baseSend,
      showToast,
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
    // The user switches tabs while the paste settles: the text + Enter must not
    // land in term-2 when the images went to term-1.
    activeHandleRef.current = 'term-2'
    let accepted = true
    await act(async () => {
      releaseSettle!()
      accepted = await sendPromise!
    })
    expect(accepted).toBe(false)
    expect(baseSend).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Message not sent', 1500)
    expect(hook!.attachments).toHaveLength(1)
  })

  it('leads the next text-only send with Ctrl+U after a failed paste, even with the chip removed', async () => {
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true), // Ctrl+U clear
      sendResult(false), // image paste rejected — stale input left in term-1
      sendResult(true) // healing Ctrl+U before the text-only send
    ])
    const baseSend = vi.fn().mockResolvedValue(true)
    mount(baseArgs({ client: client as unknown as RpcClient, baseSend }))
    await act(async () => {
      await hook!.attachImage('library')
    })
    await act(async () => {
      await hook!.sendNativeChat('hi')
    })
    expect(baseSend).not.toHaveBeenCalled()

    // The user gives up on the image and removes its chip, then sends plain text.
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
    // Failed attempt's clear + rejected paste, then the healing clear.
    expect(sendCalls).toHaveLength(3)
    expect(sendCalls[2]?.params).toMatchObject({ text: '\x15', enter: false })
    expect(baseSend).toHaveBeenCalledWith('hi again')
  })

  it('retains the stale marker when a rejected healing clear blocks text-only send', async () => {
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
    const client = makeClient([
      methodNotFound('start'),
      ok('save', '/tmp/a.png'),
      sendResult(true), // Ctrl+U clear
      sendResult(true), // image paste accepted
      sendResult(false), // first healing Ctrl+U rejected
      sendResult(true) // retry healing Ctrl+U accepted
    ])
    const baseSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
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
    expect(baseSend).toHaveBeenNthCalledWith(1, 'hi', ['file:///a.jpg'])
    expect(baseSend).toHaveBeenNthCalledWith(2, 'hi again')
  })

  it('does not reroute text when the active terminal changes during a healing clear', async () => {
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
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
    const baseSend = vi.fn().mockResolvedValueOnce(false)
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

  it('heals rejected image submits independently across terminals', async () => {
    pick
      .mockResolvedValueOnce({ base64: 'AAAA', uri: 'file:///a.jpg' })
      .mockResolvedValueOnce({ base64: 'BBBB', uri: 'file:///b.jpg' })
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
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
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
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///a.jpg' })
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
