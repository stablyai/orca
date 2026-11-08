import { createElement, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { mountFixture } from '../../test-support/rpc-recording/recorder-fixture-shape'

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
vi.mock('../../components/bottom-drawer/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: unknown }) =>
    visible ? children : null
}))
vi.mock('../../platform/haptics', () => ({
  triggerMediumImpact: vi.fn(),
  triggerSelection: vi.fn()
}))
vi.mock('../../hooks/use-now', () => ({ useNow: () => 0 }))
vi.mock('../../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('../../components/AgentStateDot', () => ({ AgentStateDot: () => null }))
vi.mock('../../session/mobile-session-styles', () => ({ styles: {} }))
vi.mock('../../transport/use-host-profile', () => ({ useHostProfile: () => null }))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]) }
})
vi.mock('../../platform/keyboard-persisting-taps', () => ({
  useKeyboardPersistingTaps: () => null
}))
vi.mock('../../navigation/workspace-execution-host', () => ({
  useWorkspaceExecutionHost: () => ({})
}))
vi.mock('../../browser/MobileBrowserPane', () => ({ MobileBrowserPane: () => null }))
vi.mock('../../session/native-chat/MobileNativeChatOverlay', () => ({
  MobileNativeChatOverlay: () => null
}))
vi.mock('../../session/MobileNativeChatForkProvider', () => ({
  MobileNativeChatForkProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../../files/session-documents/MobileSessionFileReader', () => ({ FileReader: () => null }))
vi.mock('../../files/session-documents/MobileSessionMarkdownReader', () => ({
  MarkdownReader: () => null
}))
vi.mock('../TerminalWebView', () => ({ TerminalWebView: 'TerminalWebView' }))
const keyboard = vi.hoisted(() => ({ lift: 0 }))
vi.mock('./use-mobile-session-keyboard-lift', () => ({
  useMobileSessionContentKeyboardLift: () => ({
    keyboardLift: keyboard.lift,
    activeTerminalKeyboardLift: 0,
    toastAnimatedStyle: {}
  })
}))
const stored = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      stored.set(key, value)
    })
  }
}))

import { TerminalPaneView } from './TerminalPaneView'
import { useMobileSessionTabSwitching } from '../../session/tabs/use-mobile-session-tab-switching'
import { useMobileSessionTerminalWebview } from './use-mobile-session-terminal-webview'
import { TerminalResumeState } from './terminal-stream-resume'

vi.mock('../../worktree/use-workspace-client', () => ({ useRouteCapability: () => false }))
import { resolveTerminalPaneHandles } from './mobile-terminal-pane-layout'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'

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
      terminalResume: new TerminalResumeState(),
      terminalRefs: useRef(new Map()),
      terminalPaneViewportsRef: useRef(new Map()),
      terminalGestureInputBucketsRef: useRef(new Map()),
      terminalGestureInputQueuesRef: useRef(new Map()),
      terminalGestureInputInFlightRef: useRef(new Set()),
      pendingSelectionRef: useRef(null),
      activeSessionTabTypeRef: useRef(null),
      switchSessionTabRef: useRef(null),
      setActiveSessionTabId: vi.fn(),
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
