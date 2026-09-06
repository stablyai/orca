import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileTerminalPaste } from './use-mobile-terminal-paste'
import { useTerminalLivePendingInputFlush } from '../terminal/use-terminal-live-pending-input-flush'
import type { RpcClient } from '../transport/rpc-client'

const clipboard = vi.hoisted(() => ({ getStringAsync: vi.fn(), getImageAsync: vi.fn() }))
vi.mock('expo-clipboard', () => clipboard)
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }))
vi.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: {} }))

function harness() {
  let finishClipboard!: (text: string) => void
  let rejectClipboard!: (error: Error) => void
  clipboard.getStringAsync.mockReturnValue(
    new Promise<string>((resolve, reject) => {
      finishClipboard = resolve
      rejectClipboard = reject
    })
  )
  const written: string[] = []
  const client = {
    sendRequest: vi.fn(async (_method: string, params: { text: string }) => {
      written.push(params.text)
      return { ok: true, result: { send: { accepted: true } } }
    })
  } as unknown as RpcClient
  const activeHandleRef = { current: 't' }
  const activeSessionTabTypeRef = { current: 'terminal' }
  const connStateRef = { current: 'connected' as const }
  const onError = vi.fn()
  const onSuccess = vi.fn()
  let paste!: () => Promise<void>
  let queue!: ReturnType<typeof useTerminalLivePendingInputFlush<string>>
  function Probe() {
    queue = useTerminalLivePendingInputFlush({
      activeHandleRef,
      activeSessionTabTypeRef,
      liveInputRef: { current: null },
      liveInputTerminalHandlesRef: { current: new Set(['t']) },
      sendLiveTerminalInputRef: {
        current: async (_handle, text) => {
          written.push(text)
          return true
        }
      },
      setLiveInputCapture: vi.fn()
    })
    paste = useMobileTerminalPaste({
      activeHandle: 't',
      activeHandleRef,
      activeSessionTabTypeRef,
      canSend: true,
      client,
      clientRef: { current: client },
      connState: 'connected',
      connStateRef,
      deviceTokenRef: { current: null },
      flushPendingLiveInputBeforeExternalSend: (handle, action, text, options) =>
        queue.queueLiveInputControl(handle, text ?? '', action, options),
      getActiveWorktreeConnectionId: async () => null,
      onError,
      onSuccess,
      ptyModesRef: { current: new Map() },
      refreshCanPaste: vi.fn(),
      showToast: vi.fn()
    })
    return null
  }
  let renderer!: ReturnType<typeof create>
  act(() => {
    renderer = create(createElement(Probe))
  })
  return {
    paste,
    queue,
    written,
    client,
    finishClipboard,
    rejectClipboard,
    activeHandleRef,
    activeSessionTabTypeRef,
    connStateRef,
    onError,
    onSuccess,
    unmount: () => act(() => renderer.unmount())
  }
}

afterEach(() => {
  clipboard.getStringAsync.mockReset()
  clipboard.getImageAsync.mockReset()
})

it('reserves a paste before a following Enter while clipboard reading is unresolved', async () => {
  const { paste, queue, written, finishClipboard, unmount, client } = harness()
  try {
    const pasted = paste()
    const entered = queue.queueLiveInputControl('t', '\r')
    const beforeClipboard = [...written]
    finishClipboard('clipboard-text')
    await Promise.all([pasted, entered])
    expect({ beforeClipboard, written }).toEqual({
      beforeClipboard: [],
      written: ['clipboard-text', '\r']
    })
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'clipboard-text' }),
      { failWhenDisconnected: true }
    )
  } finally {
    unmount()
  }
})

it('fences a following Enter when delayed clipboard reading rejects', async () => {
  const test = harness()
  try {
    const pasted = test.paste()
    const entered = test.queue.queueLiveInputControl('t', '\r')
    test.rejectClipboard(new Error('clipboard denied'))
    await pasted
    expect(await entered).toBe(false)
    expect(test.written).toEqual([])
    expect(test.onError).toHaveBeenCalledTimes(1)
    expect(test.onSuccess).not.toHaveBeenCalled()
  } finally {
    test.unmount()
  }
})

it('treats an empty clipboard as cancellation without poisoning following input', async () => {
  const test = harness()
  clipboard.getImageAsync.mockResolvedValue(null)
  try {
    const pasted = test.paste()
    const entered = test.queue.queueLiveInputControl('t', '\r')
    test.finishClipboard('')
    await pasted
    expect(await entered).toBe(true)
    expect(test.written).toEqual(['\r'])
    expect(test.onError).not.toHaveBeenCalled()
    expect(test.onSuccess).not.toHaveBeenCalled()
  } finally {
    test.unmount()
  }
})

it.each(['route', 'generation'] as const)(
  'cancels delayed clipboard work after %s changes',
  async (change) => {
    const test = harness()
    try {
      const pasted = test.paste()
      if (change === 'route') {
        test.activeHandleRef.current = 'other'
      } else {
        test.queue.clearPendingLiveInputCommit()
      }
      test.finishClipboard('stale clipboard')
      await pasted
      await Promise.resolve()
      expect(test.written).toEqual([])
      expect(test.client.sendRequest).not.toHaveBeenCalled()
      expect(test.onError).not.toHaveBeenCalled()
      test.activeHandleRef.current = 't'
      expect(await test.queue.queueLiveInputControl('t', 'fresh')).toBe(true)
      expect(test.written).toEqual(['fresh'])
    } finally {
      test.unmount()
    }
  }
)

it('keeps a post-dispatch transport error as failure after the route becomes stale', async () => {
  const test = harness()
  let rejectSend!: (error: Error) => void
  let dispatch!: () => void
  const dispatched = new Promise<void>((resolve) => {
    dispatch = resolve
  })
  vi.mocked(test.client.sendRequest).mockImplementationOnce(() => {
    dispatch()
    return new Promise((_resolve, reject) => {
      rejectSend = reject
    })
  })
  try {
    const pasted = test.paste()
    const entered = test.queue.queueLiveInputControl('t', '\r')
    test.finishClipboard('possibly delivered')
    await dispatched
    test.activeHandleRef.current = 'other'
    rejectSend(new Error('receipt lost'))
    await pasted
    expect(await entered).toBe(false)
    expect(test.written).toEqual([])
    expect(test.onSuccess).not.toHaveBeenCalled()
    test.activeHandleRef.current = 't'
    expect(await test.queue.queueLiveInputControl('t', 'must remain fenced')).toBe(false)
  } finally {
    test.unmount()
  }
})

it('reads the invoked clipboard while an earlier receipt still blocks paste dispatch', async () => {
  const test = harness()
  let finishEarlier!: (accepted: boolean) => void
  const earlierReceipt = new Promise<boolean>((resolve) => {
    finishEarlier = resolve
  })
  let clipboardValue = 'copied before paste'
  clipboard.getStringAsync.mockImplementation(async () => clipboardValue)
  try {
    const earlier = test.queue.queueLiveInputControl('t', '', () => earlierReceipt)
    const pasted = test.paste()
    const readsAtInvocation = clipboard.getStringAsync.mock.calls.length
    clipboardValue = 'copied after paste'
    finishEarlier(true)
    await Promise.all([earlier, pasted])
    expect({ readsAtInvocation, written: test.written }).toEqual({
      readsAtInvocation: 1,
      written: ['copied before paste']
    })
  } finally {
    test.unmount()
  }
})
