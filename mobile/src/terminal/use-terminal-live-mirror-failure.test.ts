import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalLivePendingInputFlush } from './use-terminal-live-pending-input-flush'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'

function deferred() {
  let resolve!: (sent: boolean) => void
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const unmounts: (() => void)[] = []
afterEach(() => {
  unmounts.splice(0).forEach((unmount) => unmount())
  vi.useRealTimers()
})

function harness(sender: TerminalLiveInputSender) {
  const activeHandleRef = { current: 'terminal-a' as string | null }
  const activeSessionTabTypeRef = { current: 'terminal' as string | null }
  let capturedText = ''
  let nativeText = ''
  const setLiveInputCapture = vi.fn((text: string) => {
    capturedText = text
  })
  const setNativeProps = vi.fn(({ text }: { text: string }) => {
    nativeText = text
  })
  const liveInputRef = { current: { setNativeProps } as unknown as TextInput }
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = { current: sender }
  let hook!: ReturnType<typeof useTerminalLivePendingInputFlush<string>>
  let renderer!: ReactTestRenderer
  function Harness() {
    hook = useTerminalLivePendingInputFlush({
      activeHandleRef,
      activeSessionTabTypeRef,
      liveInputRef,
      liveInputTerminalHandlesRef: { current: new Set(['terminal-a', 'terminal-b']) },
      sendLiveTerminalInputRef,
      setLiveInputCapture
    })
    return null
  }
  act(() => {
    renderer = create(createElement(Harness))
  })
  const unmount = () => {
    act(() => renderer.unmount())
  }
  unmounts.push(unmount)
  return {
    hook,
    activeHandleRef,
    activeSessionTabTypeRef,
    setNativeProps,
    setLiveInputCapture,
    text: () => ({ capturedText, nativeText }),
    type: (text: string, composing?: boolean) => {
      capturedText = text
      nativeText = text
      return hook.applyLiveInputMirror(activeHandleRef.current!, text, composing)
    },
    unmount
  }
}

describe('failed terminal live mirrors', () => {
  it.each([300, 400, 500])(
    'pipelines negotiated typing while retaining the %ims receipt barrier',
    async (delay) => {
      vi.useFakeTimers()
      const writes: { text: string; at: number }[] = []
      const start = Date.now()
      const sender = Object.assign(
        (_handle: string, text: string) => {
          writes.push({ text, at: Date.now() - start })
          return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), delay))
        },
        { supportsPipeline: () => true }
      )
      const h = harness(sender)
      const sends = []
      for (const text of ['a', 'ab', 'abc']) {
        sends.push(h.type(text))
        await vi.advanceTimersByTimeAsync(50)
      }
      expect(writes).toEqual([
        { text: 'a', at: 0 },
        { text: 'b', at: 50 },
        { text: 'c', at: 100 }
      ])
      let finished = false
      void h.hook.waitForPendingLiveInputFlush().then(() => {
        finished = true
      })
      await vi.advanceTimersByTimeAsync(delay - 51)
      expect(finished).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await Promise.all(sends)
      expect(finished).toBe(true)
    }
  )

  it.each(['refused', 'throwing'] as const)(
    'clears native and JS text on a %s send and retains the failure latch',
    async (kind) => {
      const sender = vi.fn(async () => {
        if (kind === 'throwing') {
          throw new Error('connection lost')
        }
        return false
      })
      const h = harness(sender)
      await expect(h.type('optimistic')).resolves.toBe(false)
      expect(h.text()).toEqual({ capturedText: '', nativeText: '' })
      expect(h.hook.sentLiveInputTextRef.current).toBe('')
      expect(h.hook.heldLiveInputTextRef.current).toBe('')
      expect(h.hook.pendingLiveInputHandleRef.current).toBe('terminal-a')
      await expect(h.hook.flushPendingLiveInputText('terminal-a')).resolves.toBe(false)
      await expect(h.hook.waitForPendingLiveInputFlush()).resolves.toBe(false)
      await expect(h.type('dependent suffix')).resolves.toBe(false)
      expect(sender).toHaveBeenCalledTimes(1)
    }
  )

  it('clears a newer dependent composition when its mirrored prefix fails', async () => {
    vi.useFakeTimers()
    const receipt = deferred()
    const sender = vi.fn(() => receipt.promise)
    const h = harness(sender)
    const first = h.type('x')
    const preedit = h.type('x한', true)
    receipt.resolve(false)
    await Promise.all([first, preedit])
    expect(h.text()).toEqual({ capturedText: '', nativeText: '' })
    expect(h.hook.liveInputComposingRef.current).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sender).toHaveBeenCalledTimes(1)
  })

  it('does not clear another active terminal before its lifecycle reset runs', async () => {
    const receipt = deferred()
    const h = harness(() => receipt.promise)
    const first = h.type('old')
    h.activeHandleRef.current = 'terminal-b'
    receipt.resolve(false)
    await first
    expect(h.setLiveInputCapture).not.toHaveBeenCalled()
    expect(h.setNativeProps).not.toHaveBeenCalled()
  })

  it('a canceled failure and flush cannot clear a newer same-terminal interaction', async () => {
    const old = deferred()
    const fresh = deferred()
    const h = harness((_handle, bytes) => (bytes === 'old' ? old.promise : fresh.promise))
    const first = h.type('old')
    const flush = h.hook.flushPendingLiveInputText('terminal-a')
    h.hook.clearPendingLiveInputCommit()
    const next = h.type('new')
    await expect(first).resolves.toBe(false)
    await expect(flush).resolves.toBe(false)
    expect(h.text()).toEqual({ capturedText: 'new', nativeText: 'new' })
    old.resolve(false)
    fresh.resolve(true)
    await next
    expect(h.text()).toEqual({ capturedText: 'new', nativeText: 'new' })
  })

  it('an older successful flush cannot clear text typed while it waited', async () => {
    const firstReceipt = deferred()
    const h = harness(async (_handle, text) => (text === 'a' ? firstReceipt.promise : true))
    const first = h.type('a')
    const flush = h.hook.flushPendingLiveInputText('terminal-a')
    const newer = h.type('ab')
    firstReceipt.resolve(true)
    await Promise.all([first, flush, newer])
    expect(h.text()).toEqual({ capturedText: 'ab', nativeText: 'ab' })
  })

  it('unmount cancellation cannot update the native or JS field after settlement', async () => {
    const receipt = deferred()
    const h = harness(() => receipt.promise)
    const pending = h.type('pending')
    h.unmount()
    unmounts.pop()
    receipt.resolve(false)
    await pending
    expect(h.setLiveInputCapture).not.toHaveBeenCalled()
    expect(h.setNativeProps).not.toHaveBeenCalled()
  })

  it('cancels transport input only for an unsettled mirror, before releasing its queue', async () => {
    const receipt = deferred()
    const cancelPending = vi.fn()
    const sender = Object.assign(() => receipt.promise, { cancelPending })
    const h = harness(sender)
    h.hook.clearPendingLiveInputCommit()
    expect(cancelPending).not.toHaveBeenCalled()
    const first = h.type('pending')
    h.hook.clearPendingLiveInputCommit()
    expect(cancelPending).toHaveBeenCalledExactlyOnceWith('terminal-a')
    await expect(first).resolves.toBe(false)
    receipt.resolve(true)
    const second = h.type('accepted')
    await second
    await h.hook.flushPendingLiveInputText('terminal-a')
    expect(cancelPending).toHaveBeenCalledTimes(1)
  })
})
