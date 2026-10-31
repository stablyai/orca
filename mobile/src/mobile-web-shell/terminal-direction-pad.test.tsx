import { createElement, createRef, startTransition, Suspense } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalDirectionPad, type TerminalDirectionPadHandle } from './terminal-direction-pad'

const appState = vi.hoisted(() => ({ listener: (_state: string) => {} }))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  AppState: {
    addEventListener: (_name: string, listener: (state: string) => void) => {
      appState.listener = listener
      return { remove() {} }
    }
  },
  StyleSheet: { create: <T,>(styles: T) => styles }
}))

let renderer: ReturnType<typeof create> | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
})
const touch = (pageX = 20, pageY = 20) => ({ nativeEvent: { pageX, pageY } })
function mount() {
  const send = vi.fn((_key: string) => true)
  const ref = createRef<TerminalDirectionPadHandle>()
  const render = (enabled = true) =>
    act(() => {
      const element = createElement(TerminalDirectionPad, {
        ref,
        width: 68,
        enabled,
        onKey: send,
        onInteractionStart: () => {}
      })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  render()
  const button = (direction: string) =>
    renderer!.root.findByProps({ accessibilityLabel: `D-pad ${direction}` })
  return { send, ref, render, button }
}

it.each(['up', 'down', 'left', 'right'])(
  'sends one %s tap, and repeats a hold without an extra release',
  async (direction) => {
    vi.useFakeTimers()
    const { send, button } = mount()
    const key = button(direction)
    act(() => {
      key.props.onPressIn(touch())
      key.props.onPressOut()
      key.props.onPress()
    })
    expect(send).toHaveBeenCalledExactlyOnceWith(
      `arrow${direction[0].toUpperCase()}${direction.slice(1)}`
    )
    send.mockClear()
    act(() => {
      key.props.onPressIn(touch())
      key.props.onLongPress()
    })
    expect(send).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90)
    })
    expect(send).toHaveBeenCalledTimes(3)
    act(() => {
      key.props.onPressOut()
      key.props.onPress()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(send).toHaveBeenCalledTimes(3)
  }
)

it.each(['drag', 'touch cancel', 'background', 'scroll cancel', 'disabled', 'unmount'])(
  'stops held input immediately on %s',
  async (reason) => {
    vi.useFakeTimers()
    const { send, ref, render, button } = mount()
    const key = button('up')
    act(() => {
      key.props.onPressIn(touch())
      key.props.onLongPress()
    })
    expect(send).toHaveBeenCalledTimes(1)
    act(() => {
      const pad = renderer!.root.findAll(
        (node) => String(node.type) === 'View' && node.props.onTouchCancel
      )[0]
      if (reason === 'drag') {
        pad.props.onTouchMove(touch(40, 20))
      } else if (reason === 'touch cancel') {
        pad.props.onTouchCancel()
      } else if (reason === 'background') {
        appState.listener('background')
      } else if (reason === 'scroll cancel') {
        ref.current?.cancel()
      } else if (reason === 'disabled') {
        render(false)
      } else {
        renderer!.unmount()
        renderer = undefined
      }
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(send).toHaveBeenCalledTimes(1)
    if (renderer) {
      act(() => button('up').props.onPress())
      expect(send).toHaveBeenCalledTimes(1)
    }
  }
)

it('provides four explicit accessible directions and sends their actions once', () => {
  const { send, render, button } = mount()
  for (const direction of ['up', 'down', 'left', 'right']) {
    const key = button(direction)
    expect(key.props.accessibilityHint).toContain('Hold to repeat')
    act(() => {
      key.props.onAccessibilityTap()
      key.props.onPress()
    })
  }
  expect(send.mock.calls.map(([key]) => key)).toEqual([
    'arrowUp',
    'arrowDown',
    'arrowLeft',
    'arrowRight'
  ])
  render(false)
  expect(button('up').props.accessibilityState.disabled).toBe(true)
  act(() => button('up').props.onAccessibilityTap())
  expect(send).toHaveBeenCalledTimes(4)
})

it.each([true, false])(
  'keeps committed D-pad delivery while a transition to enabled=%s is suspended',
  (nextEnabled) => {
    const committed = vi.fn((_key: string) => true)
    const next = vi.fn((_key: string) => true)
    const pending = new Promise<void>(() => {})
    function Pause({ suspend }: { suspend: boolean }) {
      if (suspend) {
        throw pending
      }
      return null
    }
    const frame = (onKey: typeof committed, enabled: boolean, suspend: boolean) => (
      <Suspense fallback={null}>
        <TerminalDirectionPad
          enabled={enabled}
          width={68}
          onKey={onKey}
          onInteractionStart={() => {}}
        />
        <Pause suspend={suspend} />
      </Suspense>
    )
    act(() => {
      renderer = create(frame(committed, true, false))
    })
    const up = renderer!.root.findByProps({ accessibilityLabel: 'D-pad up' })
    act(() => {
      startTransition(() => renderer!.update(frame(next, nextEnabled, true)))
    })
    act(() => {
      up.props.onPressIn(touch())
      up.props.onPressOut()
      up.props.onPress()
    })
    expect({ committed: committed.mock.calls, uncommitted: next.mock.calls }).toEqual({
      committed: [['arrowUp']],
      uncommitted: []
    })
    act(() => renderer!.update(frame(next, nextEnabled, false)))
    act(() => up.props.onAccessibilityTap())
    expect(committed).toHaveBeenCalledTimes(1)
    if (nextEnabled) {
      expect(next).toHaveBeenCalledExactlyOnceWith('arrowUp')
    } else {
      expect(next).not.toHaveBeenCalled()
    }
  }
)
