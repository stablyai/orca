import { Suspense, useLayoutEffect, useState, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { ScrollView } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  BridgeTerminalKeyId,
  BridgeTerminalToolbar
} from '../mobile-web-shell/bridge/bridge-terminal-key'

const native = vi.hoisted(() => ({ scrollRender: vi.fn(), mount: vi.fn(), unmount: vi.fn() }))
const insets = { top: 0, right: 84, bottom: 34, left: 0 }
const regions = { divisions: [], occlusions: [{ x: 867, y: 0, width: 84, height: 120 }] }
vi.mock('../layout/reserved-regions', () => ({ useReservedRegions: () => regions }))
vi.mock('../platform/keyboard-occlusion', () => ({ useKeyboardOcclusion: () => 0 }))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => insets }))
vi.mock('expo-router', async () => ({ useFocusEffect: (await import('react')).useEffect }))
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  return {
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: (props: { children?: ReactNode }) => {
      native.scrollRender()
      return createElement('ScrollView', props)
    },
    useWindowDimensions: () => ({ width: 951, height: 669 }),
    AppState: {
      addEventListener: () => {
        native.mount()
        return { remove: native.unmount }
      }
    },
    StyleSheet: { create: <T,>(styles: T) => styles }
  }
})
vi.mock('lucide-react-native', () => ({
  Keyboard: 'Keyboard',
  ChevronDown: 'ChevronDown',
  Monitor: 'Monitor',
  Smartphone: 'Smartphone',
  ChevronsRight: 'ChevronsRight',
  Ellipsis: 'Ellipsis'
}))
import { SideRailProvider } from '../layout/side-rail'
import { useShellTerminalKeyRail } from './shell-terminal-key-rail'

const toolbar: BridgeTerminalToolbar = {
  canSend: true,
  canCompose: true,
  keyboardVisible: false,
  liveInputEnabled: true,
  phoneDisplayMode: false,
  runsAgent: false,
  modifiers: { ctrl: 'off', alt: 'off', shift: 'off' },
  directionPadEnabled: false
}
type Input = {
  onKey: (key: BridgeTerminalKeyId) => void
  owner: string
  suspend?: boolean
  onCommit?: () => void
}
let renderer: ReturnType<typeof create> | undefined
const pending = new Promise<void>(() => {})
function mount() {
  const first = vi.fn()
  let update: (input: Input) => void = () => {}
  function Dock() {
    const [input, setInput] = useState<Input>({ onKey: first, owner: 'one' })
    update = setInput
    useShellTerminalKeyRail(true, input.onKey, input.owner, toolbar)
    useLayoutEffect(() => input.onCommit?.(), [input])
    if (input.suspend) {
      throw pending
    }
    return null
  }
  act(() => {
    renderer = create(
      <SideRailProvider>
        <Suspense fallback={null}>
          <Dock />
        </Suspense>
      </SideRailProvider>
    )
  })
  const arrow = () => renderer!.root.findByProps({ accessibilityLabel: 'Arrow Up' })
  return { first, update: (input: Input) => act(() => update(input)), arrow }
}
const touch = { nativeEvent: { pageX: 20, pageY: 20 } }
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('keeps the published native rail untouched on unrelated and callback-only dock renders', () => {
  const { first, update, arrow } = mount()
  const before = native.scrollRender.mock.calls.length
  const scroll = renderer!.root.findByType(ScrollView)
  update({ onKey: first, owner: 'one' })
  expect(native.scrollRender).toHaveBeenCalledTimes(before)
  const latest = vi.fn()
  update({ onKey: latest, owner: 'one' })
  expect(native.scrollRender).toHaveBeenCalledTimes(before)
  expect(renderer!.root.findByType(ScrollView)).toBe(scroll)
  expect(native.mount).toHaveBeenCalledTimes(1)
  expect(native.unmount).not.toHaveBeenCalled()
  act(() => {
    arrow().props.onPressIn(touch)
    arrow().props.onPress()
  })
  expect(first).not.toHaveBeenCalled()
  expect(latest).toHaveBeenCalledExactlyOnceWith('arrowUp')
})

it('keeps held keys using the committed callback and cancels them when the input owner changes', async () => {
  vi.useFakeTimers()
  const { first, update, arrow } = mount()
  act(() => {
    arrow().props.onPressIn(touch)
    arrow().props.onLongPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(first.mock.calls.length).toBeGreaterThan(1)
  const before = first.mock.calls.length
  const latest = vi.fn()
  update({ onKey: latest, owner: 'one' })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(first).toHaveBeenCalledTimes(before)
  expect(latest.mock.calls.length).toBeGreaterThan(0)
  update({ onKey: latest, owner: 'two' })
  const stopped = latest.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  act(() => {
    arrow().props.onPressOut()
    arrow().props.onPress()
  })
  expect(latest).toHaveBeenCalledTimes(stopped)
  act(() => {
    arrow().props.onPressIn(touch)
    arrow().props.onPress()
  })
  expect(latest).toHaveBeenCalledTimes(stopped + 1)
})

it('does not expose a callback from an uncommitted suspended dock render', () => {
  const { first, update, arrow } = mount()
  const uncommitted = vi.fn()
  update({ onKey: uncommitted, owner: 'one', suspend: true })
  act(() => {
    arrow().props.onPressIn(touch)
    arrow().props.onPress()
  })
  expect(first).toHaveBeenCalledExactlyOnceWith('arrowUp')
  expect(uncommitted).not.toHaveBeenCalled()
})

it('rejects a held repeat between the new owner commit and the old rail publication being replaced', async () => {
  vi.useFakeTimers()
  const { first, update, arrow } = mount()
  act(() => {
    arrow().props.onPressIn(touch)
    arrow().props.onLongPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(first).toHaveBeenCalledExactlyOnceWith('arrowUp')
  const before = native.scrollRender.mock.calls.length
  const next = vi.fn()
  const duringCommit = vi.fn(() => {
    expect(native.scrollRender).toHaveBeenCalledTimes(before)
    vi.advanceTimersByTime(45)
  })
  update({ onKey: next, owner: 'two', onCommit: duringCommit })
  expect(duringCommit).toHaveBeenCalledTimes(1)
  expect(next).not.toHaveBeenCalled()
  expect(first).toHaveBeenCalledTimes(1)
  act(() => {
    arrow().props.onPressIn(touch)
    arrow().props.onPress()
  })
  expect(next).toHaveBeenCalledExactlyOnceWith('arrowUp')
})
