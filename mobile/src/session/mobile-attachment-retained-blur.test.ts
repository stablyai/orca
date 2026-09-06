import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useMobileAttachmentInputLeaseGate } from './use-mobile-attachment-input-lease-gate'
import { useMobileSendCompletionGeneration } from './use-mobile-send-completion-generation'
import { useTerminalLivePendingInputFlush } from '../terminal/use-terminal-live-pending-input-flush'
import type { TerminalLiveExternalSend } from '../terminal/terminal-live-input-sender'

let blur: (() => void) | undefined
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    blur = effect() ?? undefined
  }
}))

it.each(['waiting', 'dispatched'] as const)(
  'fences a %s attachment at retained-route blur without poisoning input',
  async (phase) => {
    vi.useFakeTimers()
    const activeHandleRef = { current: 't' }
    const activeSessionTabTypeRef = { current: 'terminal' }
    const lease = { current: phase === 'dispatched' }
    let finish!: (sent: boolean) => void
    const receipt = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    const send = vi.fn(() => receipt)
    let gate!: TerminalLiveExternalSend
    let generation!: () => number
    let queue!: ReturnType<typeof useTerminalLivePendingInputFlush<string>>
    const written: string[] = []
    function Probe() {
      const mirror = useTerminalLivePendingInputFlush({
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
      queue = mirror
      generation = useMobileSendCompletionGeneration({ onBlur: vi.fn(), surfaceKey: 'same-route' })
      gate = useMobileAttachmentInputLeaseGate({
        flushPendingLiveInputBeforeExternalSend: (handle, action, text) =>
          mirror.queueLiveInputControl(handle, text ?? '', action),
        activeHandleRef,
        activeSessionTabTypeRef,
        connStateRef: { current: 'connected' },
        nativeChatInputLeaseReadyRef: lease,
        getSendCompletionGeneration: generation,
        showToast: vi.fn()
      })
      return null
    }
    let renderer!: ReturnType<typeof create>
    act(() => {
      renderer = create(createElement(Probe))
    })
    try {
      const initial = generation()
      const result = gate('t', send, 'image-path')
      const control = queue.queueLiveInputControl('t', '\r')
      await vi.advanceTimersByTimeAsync(200)
      act(() => blur?.())
      expect(generation()).toBeGreaterThan(initial)
      lease.current = true
      finish(true)
      await vi.advanceTimersByTimeAsync(100)
      expect(await result).toBe(phase === 'dispatched')
      expect(send).toHaveBeenCalledTimes(phase === 'dispatched' ? 1 : 0)
      expect(await control).toBe(true)
      expect(written).toEqual(['\r'])
      expect(await queue.applyLiveInputMirror('t', 'resumed', false)).toBe(true)
      expect(written).toEqual(['\r', 'resumed'])
    } finally {
      act(() => renderer.unmount())
      vi.useRealTimers()
    }
  }
)
