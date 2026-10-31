import { createElement, useLayoutEffect, useRef, useState } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { MobileSessionController } from './use-mobile-session-controller'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Alert: { alert: vi.fn() },
  ActivityIndicator: 'ActivityIndicator',
  Animated: { View: 'View' },
  StyleSheet: { create: <T,>(v: T) => v, absoluteFillObject: {} }
}))
vi.mock('lucide-react-native', () => ({
  File: 'Icon',
  FileText: 'Icon',
  Globe: 'Icon',
  Plus: 'Icon',
  SquareTerminal: 'Icon',
  Columns2: 'Icon',
  Rows2: 'Icon',
  Check: 'Icon',
  LayoutGrid: 'Icon',
  Edit3: 'Icon',
  Trash2: 'Icon'
}))
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: unknown }) =>
    visible ? children : null
}))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: vi.fn(), triggerSelection: vi.fn() }))
vi.mock('../hooks/use-now', () => ({ useNow: () => 0 }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('../components/AgentStateDot', () => ({ AgentStateDot: () => null }))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('../transport/use-host-profile', () => ({ useHostProfile: () => null }))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]) }
})
vi.mock('../platform/keyboard-persisting-taps', () => ({ useKeyboardPersistingTaps: () => null }))
vi.mock('../navigation/workspace-execution-host', () => ({ useWorkspaceExecutionHost: () => ({}) }))
vi.mock('../browser/MobileBrowserPane', () => ({ MobileBrowserPane: () => null }))
vi.mock('./MobileNativeChatOverlay', () => ({ MobileNativeChatOverlay: () => null }))
vi.mock('./MobileSessionFileReader', () => ({ FileReader: () => null }))
vi.mock('./MobileSessionMarkdownReader', () => ({ MarkdownReader: () => null }))
vi.mock('../terminal/TerminalWebView', () => ({ TerminalWebView: 'TerminalWebView' }))
const stored = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      stored.set(key, value)
    })
  }
}))
import { useTerminalSplitLayout } from './use-terminal-split-layout'
import { MobileSessionTerminalLayoutSheet } from './MobileSessionTerminalLayoutSheet'
import { MobileSessionActiveContent } from './MobileSessionActiveContent'
import { TerminalPaneView } from './TerminalPaneView'
import { useMobileSessionTabSwitching } from './use-mobile-session-tab-switching'
import { useMobileSessionTerminalWebview } from './use-mobile-session-terminal-webview'
import { resolveTerminalPaneHandles } from './mobile-terminal-pane-layout'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'

type Controller = MobileSessionController

it('lets the split menu override sidebar width and rotation without remounting panes or changing focus', async () => {
  let setKeyboard!: (height: number) => void
  let openLayoutMenu!: () => void
  function Harness() {
    const preference = useTerminalSplitLayout()
    const [split, setSplit] = useState(true)
    const [showTerminalLayout, setShowTerminalLayout] = useState(false)
    openLayoutMenu = () => setShowTerminalLayout(true)
    const [active, setActive] = useState('b')
    const [keyboard, setKeyboardState] = useState(0)
    setKeyboard = setKeyboardState
    const controller = mountFixture<Controller>({
      ...preference,
      terminalSplitActive: split,
      setShowTerminalLayout,
      toggleTerminalSplit: () => setSplit(!split),
      canSplitTerminals: true,
      terminals: [
        { handle: 'a', title: 'First' },
        { handle: 'b', title: 'Second' }
      ],
      activeHandle: active,
      visibleTerminalHandles: split ? ['a', 'b'] : [active],
      activeHandleRef: { current: active },
      activeSessionTabIdRef: { current: null },
      visibleTabs: [],
      tabStripRef: { current: null },
      tabStripOffsetRef: { current: 0 },
      tabStripViewportWidthRef: { current: 0 },
      tabStripContentWidthRef: { current: 0 },
      tabLayoutsRef: { current: new Map() },
      terminalKeyboardMetrics: new Map(),
      getTerminalPaneViewport: () => ({
        terminalFrameRef: { current: null },
        viewportRef: { current: null },
        viewportMeasuredRef: { current: false }
      }),
      keyboardLift: keyboard,
      activeTerminalKeyboardLift: 0,
      terminalTextScale: 1,
      nativeChatSendError: {},
      dictation: {},
      notifyTerminalFrame: vi.fn(),
      setTerminalWebViewRef: vi.fn(),
      handleTerminalTap: setActive
    })
    return createElement(
      'Screen',
      null,
      createElement(MobileSessionTerminalLayoutSheet, {
        controller,
        visible: showTerminalLayout,
        onClose: () => setShowTerminalLayout(false)
      }),
      createElement(MobileSessionActiveContent, { controller })
    )
  }
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(createElement(Harness))
  })
  const frame = tree.root
    .findByType(MobileSessionActiveContent)
    .findAll((node) => typeof node.type === 'string' && String(node.type) === 'View')[0]
  const resize = (width: number, height: number) =>
    act(() => frame.props.onLayout({ nativeEvent: { layout: { width, height } } }))
  const panes = () => tree.root.findAllByType(TerminalPaneView)
  const geometry = (index: number) =>
    Object.assign(
      {},
      ...panes()
        [index].findAll((node) => typeof node.type === 'string' && String(node.type) === 'View')[0]
        .props.style.filter(Boolean)
    )
  const originalTerminals = tree.root.findAll(
    (node) => typeof node.type === 'string' && String(node.type) === 'TerminalWebView'
  )
  const choose = (label: string) => {
    act(() => openLayoutMenu())
    const row = tree.root
      .findAll((node) => typeof node.type === 'string' && String(node.type) === 'Pressable')
      .find((node) =>
        node
          .findAll((node) => typeof node.type === 'string' && String(node.type) === 'Text')
          .some((text) => text.props.children === label)
      )
    expect(row, `visible terminal layout choice: ${label}`).toBeDefined()
    act(() => row!.props.onPress())
  }
  try {
    resize(587, 330)
    expect(geometry(1).top).toBe(165)
    choose('Side by side')
    expect(geometry(1)).toMatchObject({ width: '50%', left: '50%', top: 0 })
    resize(927, 330)
    expect(geometry(1).left).toBe('50%')
    resize(390, 700)
    expect(geometry(1).left).toBe('50%')
    act(() => setKeyboard(300))
    expect(geometry(1).height).toBe(400)
    choose('Stacked')
    expect(geometry(1)).toMatchObject({ top: 200, height: 200 })
    act(() => setKeyboard(0))
    resize(927, 330)
    expect(geometry(1)).toMatchObject({ top: 165, height: 165 })
    choose('Auto')
    expect(geometry(1).left).toBe('50%')
    resize(587, 330)
    expect(geometry(1).top).toBe(165)
    expect(panes().map((p) => [p.props.handle, p.props.active])).toEqual([
      ['a', false],
      ['b', true]
    ])
    expect(
      tree.root.findAll(
        (node) => typeof node.type === 'string' && String(node.type) === 'TerminalWebView'
      )
    ).toEqual(originalTerminals)
    choose('One terminal')
    expect(panes().map((p) => p.props.visible)).toEqual([false, true])
    choose('Side by side')
    expect(panes().map((p) => p.props.visible)).toEqual([true, true])
    await act(async () => {})
    expect(stored.get('orca:terminalSplitLayout')).toBe('side-by-side')
    act(() => tree.unmount())
    await act(async () => {
      tree = create(createElement(Harness))
    })
    const restoredFrame = tree.root
      .findByType(MobileSessionActiveContent)
      .findAll((node) => typeof node.type === 'string' && String(node.type) === 'View')[0]
    act(() =>
      restoredFrame.props.onLayout({ nativeEvent: { layout: { width: 587, height: 330 } } })
    )
    expect(geometry(1)).toMatchObject({ width: '50%', left: '50%' })
  } finally {
    act(() => tree.unmount())
  }
})

it('keeps C paired with A after replacing B and focusing A by its first terminal touch', () => {
  const focus = vi.fn()
  const terminals = ['a', 'b', 'c'].map((handle) => ({
    handle,
    title: handle,
    isActive: handle === 'a'
  }))
  const tabs = terminals.map((t) => ({
    type: 'terminal' as const,
    id: t.handle,
    title: t.title,
    terminal: t.handle,
    isActive: t.isActive
  }))
  let switchTo!: ReturnType<typeof useMobileSessionTabSwitching>['switchSessionTab']
  let frameCallback: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameCallback = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  function Harness() {
    const [active, setActive] = useState<string | null>('a')
    const [pair, setPair] = useState<readonly string[] | null>(['a', 'b'])
    const visible = resolveTerminalPaneHandles(
      active,
      pair,
      terminals.map((t) => t.handle)
    )
    const activeRef = useRef(active)
    const visibleRef = useRef(visible)
    useLayoutEffect(() => {
      activeRef.current = active
      visibleRef.current = visible
    })
    const scope = mountFixture<Parameters<typeof useMobileSessionTabSwitching>[0]>({
      activeHandle: active,
      activeHandleRef: activeRef,
      setActiveHandle: setActive,
      splitTerminalHandles: pair,
      setSplitTerminalHandles: setPair,
      visibleTerminalHandles: visible,
      visibleTerminalHandlesRef: visibleRef,
      terminals,
      sessionTabs: tabs,
      client: null,
      connState: 'connected',
      terminalDiagnosticsRef: useRef(new MobileTerminalDiagnostics()),
      terminalUnsubsRef: useRef(new Map()),
      terminalRefs: useRef(new Map()),
      terminalPaneViewportsRef: useRef(new Map()),
      terminalGestureInputBucketsRef: useRef(new Map()),
      terminalGestureInputQueuesRef: useRef(new Map()),
      terminalGestureInputInFlightRef: useRef(new Set()),
      pendingSelectionRef: useRef(null),
      activeSessionTabTypeRef: useRef(null),
      switchSessionTabRef: useRef(null),
      setActiveSessionTabId: vi.fn(),
      defaultTerminalHandlesToLiveInput: vi.fn(),
      subscribeToTerminal: vi.fn(),
      unsubscribeTerminal: vi.fn(),
      handleTerminalTap: focus
    })
    const switching = useMobileSessionTabSwitching(scope)
    switchTo = switching.switchSessionTab
    const webview = useMobileSessionTerminalWebview({ ...scope, ...switching })
    return createElement(
      'Screen',
      null,
      terminals.map((terminal) =>
        createElement(
          TerminalPaneView,
          mountFixture<Parameters<typeof TerminalPaneView>[0] & { key: string }>({
            key: terminal.handle,
            handle: terminal.handle,
            active: active === terminal.handle,
            visible: visible.includes(terminal.handle),
            splitIndex: visible.includes(terminal.handle)
              ? visible.indexOf(terminal.handle)
              : undefined,
            splitFrame: { width: 587, height: 330 },
            splitDirection: 'row',
            keyboardLift: 0,
            textScale: 1,
            onRef: webview.setTerminalWebViewRef,
            onTerminalInteraction: webview.handleTerminalInteraction,
            onTerminalTap: webview.handleTerminalTap
          })
        )
      )
    )
  }
  let tree!: ReturnType<typeof create>
  act(() => {
    tree = create(createElement(Harness))
  })
  const panes = () => tree.root.findAllByType(TerminalPaneView)
  const visible = () =>
    panes()
      .filter((p) => p.props.visible)
      .sort((a, b) => a.props.splitIndex - b.props.splitIndex)
      .map((p) => p.props.handle)
  const originalPanes = panes()
  try {
    act(() => switchTo(tabs[2]))
    expect(visible()).toEqual(['c', 'a'])
    const a = panes().find((p) => p.props.handle === 'a')!
    const terminal = a.find(
      (node) => typeof node.type === 'string' && String(node.type) === 'TerminalWebView'
    )
    act(() => terminal.props.onTerminalInteraction())
    expect(visible()).toEqual(['c', 'a'])
    act(() => {
      terminal.props.onTerminalTap()
      frameCallback?.(0)
    })
    expect(focus).toHaveBeenLastCalledWith('a')
    expect(visible()).toEqual(['c', 'a'])
    expect(panes()).toEqual(originalPanes)
  } finally {
    act(() => tree.unmount())
    vi.unstubAllGlobals()
  }
})
