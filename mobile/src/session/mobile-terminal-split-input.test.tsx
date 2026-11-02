// @vitest-environment happy-dom
import { createElement, useState } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { useTerminalLiveInputCommit } from '../terminal/use-terminal-live-input-commit'
import { useMobileSessionTerminalWebview } from './use-mobile-session-terminal-webview'
import { terminalPaneViewport, type TerminalPaneViewport } from './mobile-terminal-pane-layout'

vi.mock('../platform/live-input-composing-range', () => ({
  reportedLiveInputComposing: (isComposing: boolean | undefined) => isComposing
}))

it('a pane tap moves the one input owner without dropping either stream or forwarding old preedit', async () => {
  vi.useFakeTimers()
  const activeHandleRef = { current: 'a' }
  const visibleTerminalHandlesRef = { current: ['a', 'b'] }
  const subscriptions = {
    current: new Map([
      ['a', vi.fn()],
      ['b', vi.fn()]
    ])
  }
  const geometry = { current: new Map<string, TerminalPaneViewport>() }
  const send = vi.fn(async (_handle: string, _text: string) => true)
  const focus = vi.fn()
  const unsubscribe = vi.fn()
  const handles = new Set(['a', 'b'])
  let tap!: (handle: string) => void
  let change!: ReturnType<typeof useTerminalLiveInputCommit>['handleLiveInputChange']
  function Probe() {
    const [activeHandle, setActiveHandle] = useState('a')
    const webview = useMobileSessionTerminalWebview(
      mountFixture({
        activeHandle,
        activeHandleRef,
        terminals: [
          { handle: 'a', title: 'A', isActive: true },
          { handle: 'b', title: 'B', isActive: false }
        ],
        visibleTerminalHandles: ['a', 'b'],
        visibleTerminalHandlesRef,
        terminalPaneViewportsRef: geometry,
        getTerminalPaneViewport: (handle) => terminalPaneViewport(geometry.current, handle),
        setSplitTerminalHandles: vi.fn(),
        showNativeChat: false,
        connState: 'connected',
        switchTab: (handle) => {
          activeHandleRef.current = handle
          setActiveHandle(handle)
        },
        handleTerminalTap: focus,
        subscribeToTerminal: vi.fn(),
        unsubscribeTerminal: unsubscribe,
        terminalUnsubsRef: subscriptions,
        activeSessionTab: null,
        markdownDocs: new Map(),
        fileDocs: new Map()
      })
    )
    tap = webview.handleTerminalTap
    const input = useTerminalLiveInputCommit({
      activeHandle,
      activeHandleRef,
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef: { current: 'terminal' },
      connected: true,
      liveInputRef: { current: null },
      liveInputTerminalHandles: handles,
      liveInputTerminalHandlesRef: { current: handles },
      sendLiveTerminalInputRef: { current: send },
      setLiveInputCapture: vi.fn()
    })
    change = input.handleLiveInputChange
    return null
  }
  let renderer!: ReturnType<typeof create>
  try {
    act(() => {
      renderer = create(createElement(Probe))
    })
    act(() => {
      change({ nativeEvent: { text: 'ni', isComposing: true } })
    })
    act(() => {
      tap('b')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30)
    })
    expect(activeHandleRef.current).toBe('b')
    expect(focus).toHaveBeenCalledWith('b')
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(subscriptions.current.size).toBe(2)
    act(() => {
      change({ nativeEvent: { text: 'hello', isComposing: false } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(send.mock.calls).toEqual([['b', 'hello']])
    act(() => {
      tap('hidden')
    })
    expect(activeHandleRef.current).toBe('b')
  } finally {
    act(() => renderer?.unmount())
    vi.useRealTimers()
  }
})
