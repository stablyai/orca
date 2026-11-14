import { createElement, startTransition, Suspense, type ReactNode } from 'react'
import { ScrollView } from 'react-native'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { SideRailStrip } from '../layout/side-rail-strip'

const outlet = vi.hoisted((): { node: ReactNode } => ({ node: null }))
const appState = vi.hoisted(() => ({ listener: (_state: string) => {}, remove: vi.fn() }))
const railState = vi.hoisted((): { strip: SideRailStrip | null; capable: boolean } => ({
  strip: null,
  capable: true
}))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listener = listener
      return { remove: appState.remove }
    }
  },
  StyleSheet: { create: <T,>(styles: T) => styles }
}))
vi.mock('lucide-react-native', () => ({
  Keyboard: 'KeyboardIcon',
  ChevronDown: 'ChevronDown',
  Monitor: 'Monitor',
  Smartphone: 'Smartphone',
  ChevronsRight: 'ChevronsRight',
  Ellipsis: 'Ellipsis'
}))
vi.mock('expo-router', async () => ({ useFocusEffect: (await import('react')).useEffect }))
vi.mock('../layout/side-rail', () => ({
  useSideRailContent: (node: ReactNode) => {
    outlet.node = node
  },
  useSideRailDirectionPadAvailable: () => railState.capable,
  useSideRailStrip: () => railState.strip
}))
import { TerminalKeyRail, terminalKeyRailKeys } from './terminal-key-rail'
import { useShellKeyRail, usePublishedShellKeyRail } from './use-shell-key-rail'
import type { BridgeTerminalToolbar } from './bridge/bridge-terminal-key'

const SHELL_TOOLBAR: BridgeTerminalToolbar = {
  canSend: true,
  canCompose: true,
  keyboardVisible: false,
  liveInputEnabled: true,
  phoneDisplayMode: false,
  runsAgent: false,
  modifiers: { ctrl: 'off', alt: 'off', shift: 'off' },
  directionPadEnabled: false
}

let renderer: ReturnType<typeof create> | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  railState.strip = null
  railState.capable = true
  vi.useRealTimers()
})
function mount() {
  const send = vi.fn((_key: string) => true)
  act(() => {
    renderer = create(
      createElement(TerminalKeyRail, {
        keys: terminalKeyRailKeys(100, SHELL_TOOLBAR),
        toolbar: SHELL_TOOLBAR,
        onKey: send
      })
    )
  })
  const root = renderer!.root
  const key = (label: string): ReactTestInstance => root.findByProps({ accessibilityLabel: label })
  return { send, root, key }
}
const touch = (pageY: number) => ({ nativeEvent: { pageX: 20, pageY } })

it('cancels a swipe starting on a key before it can send or repeat', async () => {
  vi.useFakeTimers()
  const { send, root, key } = mount()
  const arrow = key('Arrow Up')
  act(() => arrow.props.onPressIn(touch(20)))
  act(() => root.findByType(ScrollView).props.onTouchMove(touch(40)))
  act(() => {
    arrow.props.onLongPress()
    arrow.props.onPressOut()
    arrow.props.onPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(send).not.toHaveBeenCalled()
})
it('repeats a held key and cancels on drag, release, and unmount without an extra tap', async () => {
  vi.useFakeTimers()
  const { send, root, key } = mount()
  const arrow = key('Arrow Down')
  act(() => {
    arrow.props.onPressIn(touch(20))
    arrow.props.onLongPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(445)
  })
  expect(send.mock.calls.length).toBeGreaterThan(1)
  act(() => root.findByType(ScrollView).props.onScrollBeginDrag())
  const count = send.mock.calls.length
  act(() => {
    arrow.props.onPressOut()
    arrow.props.onPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(send).toHaveBeenCalledTimes(count)
  act(() => {
    arrow.props.onPressIn(touch(20))
    arrow.props.onLongPress()
  })
  act(() => renderer?.unmount())
  renderer = undefined
  const afterUnmount = send.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(send).toHaveBeenCalledTimes(afterUnmount)
})

it.each(['release', 'background', 'touch cancel'])('stops a held repeat on %s', async (reason) => {
  vi.useFakeTimers()
  const { send, root, key } = mount()
  const arrow = key('Arrow Up')
  act(() => {
    arrow.props.onPressIn(touch(20))
    arrow.props.onLongPress()
  })
  expect(send).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45)
  })
  expect(send).toHaveBeenCalledTimes(2)
  act(() => {
    if (reason === 'release') {
      arrow.props.onPressOut()
    } else if (reason === 'background') {
      appState.listener('background')
    } else {
      root.findByType(ScrollView).props.onTouchCancel()
    }
    arrow.props.onPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(send).toHaveBeenCalledTimes(2)
})
it('does not send a non-repeatable key during a swipe', () => {
  const { send, root, key } = mount()
  const escape = key('Escape')
  act(() => {
    escape.props.onPressIn(touch(20))
    root.findByType(ScrollView).props.onTouchMove(touch(40))
    escape.props.onPressOut()
    escape.props.onPress()
  })
  expect(send).not.toHaveBeenCalled()
})
it.each([
  ['Escape', 'escape'],
  ['Control', 'ctrl']
])('sends held non-repeatable %s on release under native long-press suppression', (label, id) => {
  const { send, key } = mount()
  const button = key(label)
  act(() => {
    button.props.onPressIn(touch(20))
    button.props.onLongPress?.()
    button.props.onPressOut()
    // RN Pressability suppresses release onPress after a long press when a handler exists.
    if (button.props.onLongPress == null) {
      button.props.onPress()
    }
  })
  expect(send).toHaveBeenCalledExactlyOnceWith(id)
})

function mountRailHost() {
  railState.strip = { side: 'right', width: 84, height: 500, top: 0, bottom: 0 }
  const bridge = { publishTerminalKeyRail: vi.fn(), sendTerminalKey: vi.fn(() => true) }
  let reportClaim: ReturnType<typeof useShellKeyRail>['reportClaim'] = () => {}
  function TerminalKeyRailHost({ overlay = false }: { overlay?: boolean }) {
    const rail = useShellKeyRail({
      sessionId: 'session',
      overlay,
      routeGrants: ['terminalKeyRail']
    })
    reportClaim = rail.reportClaim
    usePublishedShellKeyRail(rail.keys, bridge, rail.inputOwner, rail.toolbar)
    return outlet.node
  }
  act(() => {
    renderer = create(createElement(TerminalKeyRailHost))
  })
  const toolbar = SHELL_TOOLBAR
  const claim = (owner = 'pane-a', next = toolbar) =>
    act(() => {
      reportClaim(true, owner, structuredClone(next))
    })
  claim()
  const arrow = () => renderer!.root.findByProps({ accessibilityLabel: 'Arrow Up' })
  return {
    bridge,
    claim,
    arrow,
    toolbar,
    reportClaim,
    refresh: () => act(() => renderer!.update(createElement(TerminalKeyRailHost))),
    cover: () => act(() => renderer!.update(createElement(TerminalKeyRailHost, { overlay: true })))
  }
}

it('delivers a release tap across an equivalent serialized rail claim', () => {
  const h = mountRailHost()
  const arrow = h.arrow()
  act(() => arrow.props.onPressIn(touch(20)))
  h.claim()
  act(() => {
    arrow.props.onPressOut()
    arrow.props.onPress()
  })
  expect(h.bridge.sendTerminalKey).toHaveBeenCalledExactlyOnceWith('arrowUp', 'pane-a')
})

it('continues held repeats across an equivalent serialized rail claim', async () => {
  vi.useFakeTimers()
  const h = mountRailHost()
  act(() => {
    h.arrow().props.onPressIn(touch(20))
    h.arrow().props.onLongPress()
  })
  h.claim()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90)
  })
  expect(h.bridge.sendTerminalKey).toHaveBeenCalledTimes(3)
  expect(h.bridge.sendTerminalKey).toHaveBeenLastCalledWith('arrowUp', 'pane-a')
  act(() => {
    h.arrow().props.onPressOut()
    h.arrow().props.onPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90)
  })
  expect(h.bridge.sendTerminalKey).toHaveBeenCalledTimes(3)
})

it.each(['toolbar', 'keys', 'release', 'overlay', 'layout'])(
  'cancels held rail input on a real %s change',
  async (change) => {
    vi.useFakeTimers()
    const h = mountRailHost()
    act(() => {
      h.arrow().props.onPressIn(touch(20))
      h.arrow().props.onLongPress()
    })
    if (change === 'owner') {
      h.claim('pane-b')
    }
    if (change === 'toolbar') {
      h.claim('pane-a', { ...h.toolbar, canSend: false })
    }
    if (change === 'keys') {
      h.claim('pane-a', { ...h.toolbar, runsAgent: true })
    }
    if (change === 'release') {
      act(() => h.reportClaim(false))
    }
    if (change === 'overlay') {
      h.cover()
    }
    if (change === 'layout') {
      railState.strip = { side: 'right', width: 84, height: 140, top: 0, bottom: 0 }
      h.refresh()
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90)
    })
    expect(h.bridge.sendTerminalKey).toHaveBeenCalledExactlyOnceWith('arrowUp', 'pane-a')
  }
)

it('cancels held input when only the owner changes and keys stay identical', async () => {
  vi.useFakeTimers()
  railState.strip = { side: 'right', width: 84, height: 500, top: 0, bottom: 0 }
  const toolbar = SHELL_TOOLBAR
  const keys = terminalKeyRailKeys(500, toolbar)
  const send = vi.fn(() => true)
  const render = (inputOwner: string) =>
    act(() => {
      const node = createElement(TerminalKeyRail, { keys, toolbar, onKey: send, inputOwner })
      if (renderer) {
        renderer.update(node)
      } else {
        renderer = create(node)
      }
    })
  render('pane-a')
  const arrow = renderer!.root.findByProps({ accessibilityLabel: 'Arrow Up' })
  act(() => {
    arrow.props.onPressIn(touch(20))
    arrow.props.onLongPress()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90)
  })
  expect(send).toHaveBeenCalledTimes(3)
  const sent = send.mock.calls.length
  render('pane-b')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(180)
  })
  act(() => {
    arrow.props.onPressOut()
    arrow.props.onPress()
  })
  expect(send).toHaveBeenCalledTimes(sent)
})

it('keeps the committed shell sender while a bridge transition is suspended', () => {
  railState.strip = { side: 'right', width: 84, height: 500, top: 0, bottom: 0 }
  const committed = vi.fn((_key: string, _owner?: string) => true)
  const next = vi.fn((_key: string, _owner?: string) => false)
  const publish = vi.fn()
  const keys = terminalKeyRailKeys(500, SHELL_TOOLBAR)
  const pending = new Promise<void>(() => {})
  function Host({ send, suspend = false }: { send: typeof committed; suspend?: boolean }) {
    usePublishedShellKeyRail(
      keys,
      { publishTerminalKeyRail: publish, sendTerminalKey: send },
      'pane-a',
      SHELL_TOOLBAR
    )
    if (suspend) {
      throw pending
    }
    return outlet.node
  }
  act(() => {
    renderer = create(
      <Suspense fallback={null}>
        <Host send={committed} />
      </Suspense>
    )
  })
  const arrow = renderer!.root.findByProps({ accessibilityLabel: 'Arrow Up' })
  act(() => {
    startTransition(() =>
      renderer!.update(
        <Suspense fallback={null}>
          <Host send={next} suspend />
        </Suspense>
      )
    )
  })
  act(() => {
    arrow.props.onPressIn(touch(20))
    arrow.props.onPressOut()
    arrow.props.onPress()
  })
  expect({ committed: committed.mock.calls, uncommitted: next.mock.calls }).toEqual({
    committed: [['arrowUp', 'pane-a']],
    uncommitted: []
  })
  act(() =>
    renderer!.update(
      <Suspense fallback={null}>
        <Host send={next} />
      </Suspense>
    )
  )
  act(() => {
    arrow.props.onPressIn(touch(20))
    arrow.props.onPressOut()
    arrow.props.onPress()
  })
  expect(committed).toHaveBeenCalledTimes(1)
  expect(next).toHaveBeenCalledExactlyOnceWith('arrowUp', 'pane-a')
})
