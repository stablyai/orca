import { createElement, useRef, useState } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { triggerMediumImpact } from '../platform/haptics'
import type { MobileSessionTab } from './mobile-session-route-types'
import { MobileSessionTabStrip, SESSION_TAB_DOUBLE_TAP_MS } from './MobileSessionTabStrip'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useMobileSessionKeyboardState } from './use-mobile-session-keyboard-state'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'

vi.mock('react-native', () => ({
  Platform: { select: (options: { default?: unknown }) => options.default },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: {
    absoluteFillObject: {},
    create: <T,>(styles: T) => styles,
    hairlineWidth: 1
  },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  File: 'File',
  FileText: 'FileText',
  Globe: 'Globe',
  Plus: 'Plus',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal'
}))

vi.mock('../platform/haptics', () => ({
  triggerMediumImpact: vi.fn()
}))
vi.mock('../hooks/use-now', () => ({ useNow: () => 0 }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))
vi.mock('../components/AgentStateDot', () => ({ AgentStateDot: () => null }))
vi.mock('./MobileSessionHeaderIconButton', () => ({ MobileSessionHeaderIconButton: () => null }))
vi.mock('./QuickCommandsTabButton', () => ({ QuickCommandsTabButton: () => null }))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('../platform/keyboard-persisting-taps', () => ({
  useKeyboardPersistingTaps: () => () => {}
}))
vi.mock('../platform/keyboard-occlusion', () => ({
  useSoftKeyboard: () => ({ height: 0, visible: false })
}))
vi.mock('../terminal/terminal-viewport-refit', () => ({
  useTerminalViewportRefit: () => ({ notifyKeyboardVisibility: () => {} })
}))
vi.mock('../worktree/last-visited-worktree-repo', () => ({ writeLastVisitedWorktree: () => {} }))

type Controller = Parameters<typeof MobileSessionTabStrip>[0]['controller']
type KeyboardScope = Parameters<typeof useMobileSessionKeyboardState>[0]

function terminalTab(id: string, handle: string | null, title: string): MobileSessionTab {
  return { type: 'terminal', id, title, terminal: handle, isActive: false }
}

function fileTab(): MobileSessionTab {
  return {
    type: 'file',
    id: 'file-1',
    title: 'notes.ts',
    filePath: '/tmp/notes.ts',
    relativePath: 'notes.ts',
    isDirty: false,
    isActive: false
  }
}

describe('MobileSessionTabStrip', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T00:00:00.000Z'))
    vi.mocked(triggerMediumImpact).mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  function renderStrip(tabs: MobileSessionTab[], activeHandle: string | null) {
    const switchSessionTab = vi.fn<(tab: MobileSessionTab) => void>()
    const setRenameTarget = vi.fn()
    const activeHandleRef = { current: activeHandle }
    const controller = {
      connState: 'connected' as const,
      activeSessionTabId: tabs[0]?.id ?? null,
      activeSessionTabIdRef: { current: tabs[0]?.id ?? null },
      tabStripRef: { current: null },
      tabStripOffsetRef: { current: 0 },
      tabStripViewportWidthRef: { current: 0 },
      tabStripContentWidthRef: { current: 0 },
      tabLayoutsRef: { current: new Map<string, { x: number; width: number }>() },
      creating: false,
      creatingBrowser: false,
      creatingMarkdown: false,
      setCreateError: vi.fn(),
      setShowCreateTabDrawer: vi.fn(),
      setShowQuickCommands: vi.fn(),
      quickCommandsSupported: true,
      showToast: vi.fn(),
      scrollActiveTabIntoView: vi.fn(),
      holdTabStripReveal: vi.fn(),
      cancelHeldTabStripReveal: vi.fn(),
      switchSessionTab,
      openSessionTabActionSheetAfterKeyboardDismiss: vi.fn(),
      visibleTabs: tabs,
      terminals: [],
      setRenameTarget,
      activeHandleRef
    }
    act(() => {
      renderer = create(
        createElement(MobileSessionTabStrip, {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the strip reads only the tab-press and layout fields this fixture sets.
          controller: controller as unknown as MobileSessionController,
          inTopBar: false
        })
      )
    })
    return { switchSessionTab, setRenameTarget }
  }

  function tabButtons(): ReactTestInstance[] {
    return renderer!.root.findAll(
      (node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'tab'
    )
  }

  function press(node: ReactTestInstance): void {
    act(() => {
      node.props.onPress()
    })
  }

  it('switches on a single tap and renames a terminal on a second tap within 300ms', () => {
    const tab = terminalTab('term-1', 'pty-1', 'shell')
    const { switchSessionTab, setRenameTarget } = renderStrip([tab], 'pty-1')
    const [pressed] = tabButtons()

    press(pressed)
    expect(switchSessionTab).toHaveBeenCalledExactlyOnceWith(tab)
    expect(setRenameTarget).not.toHaveBeenCalled()
    expect(triggerMediumImpact).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(SESSION_TAB_DOUBLE_TAP_MS - 1)
    })
    press(pressed)
    expect(switchSessionTab).toHaveBeenCalledTimes(1)
    expect(setRenameTarget).toHaveBeenCalledExactlyOnceWith({
      handle: 'pty-1',
      title: 'shell',
      isActive: true
    })
    expect(triggerMediumImpact).toHaveBeenCalledTimes(1)

    press(pressed)
    expect(switchSessionTab).toHaveBeenCalledTimes(2)
    expect(setRenameTarget).toHaveBeenCalledTimes(1)
  })

  it('marks the rename inactive when that terminal is not the active handle', () => {
    const tab = terminalTab('term-1', 'pty-1', 'shell')
    const { setRenameTarget } = renderStrip([tab], 'other-pty')
    const [pressed] = tabButtons()
    press(pressed)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    press(pressed)
    expect(setRenameTarget).toHaveBeenCalledExactlyOnceWith({
      handle: 'pty-1',
      title: 'shell',
      isActive: false
    })
  })

  it('switches again when the second tap is outside the window', () => {
    const tab = terminalTab('term-1', 'pty-1', 'shell')
    const { switchSessionTab, setRenameTarget } = renderStrip([tab], 'pty-1')
    const [pressed] = tabButtons()
    press(pressed)
    act(() => {
      vi.advanceTimersByTime(SESSION_TAB_DOUBLE_TAP_MS)
    })
    press(pressed)
    expect(switchSessionTab).toHaveBeenCalledTimes(2)
    expect(setRenameTarget).not.toHaveBeenCalled()
  })

  it('keeps switching a non-terminal tab and a terminal that has no handle', () => {
    const file = fileTab()
    const pending = terminalTab('pending', null, 'Starting')
    const { switchSessionTab, setRenameTarget } = renderStrip([file, pending], null)
    const [fileButton, pendingButton] = tabButtons()

    press(fileButton)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    press(fileButton)
    press(pendingButton)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    press(pendingButton)

    expect(switchSessionTab).toHaveBeenCalledTimes(4)
    expect(setRenameTarget).not.toHaveBeenCalled()
    expect(triggerMediumImpact).not.toHaveBeenCalled()
  })

  it('does not rename when the second tap lands on a different tab', () => {
    const first = terminalTab('term-1', 'pty-1', 'one')
    const second = terminalTab('term-2', 'pty-2', 'two')
    const { switchSessionTab, setRenameTarget } = renderStrip([first, second], 'pty-1')
    const [firstButton, secondButton] = tabButtons()
    press(firstButton)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    press(secondButton)
    expect(switchSessionTab).toHaveBeenCalledTimes(2)
    expect(switchSessionTab).toHaveBeenNthCalledWith(1, first)
    expect(switchSessionTab).toHaveBeenNthCalledWith(2, second)
    expect(setRenameTarget).not.toHaveBeenCalled()
  })
})

const TAB_IDS = ['a', 'b', 'c', 'd', 'e']
const TAB_WIDTH = 100
const visibleTabs = TAB_IDS.map((id) => ({
  type: 'terminal' as const,
  id,
  terminal: `term-${id}`,
  title: id
}))

// The real activation reveal runs, so switching tabs scrolls the strip as it does in the app.
function mountStrip(
  terminals: Pick<Controller['terminals'][number], 'handle' | 'agentIdentity'>[] = []
) {
  const scrollTo = vi.fn()
  const setRenameTarget = vi.fn()
  const offsetRef = { current: 0 }
  function Harness() {
    const [activeSessionTabId, setActiveSessionTabId] = useState('a')
    const activeSessionTabIdRef = useRef(activeSessionTabId)
    activeSessionTabIdRef.current = activeSessionTabId
    const strip = {
      activeSessionTabId,
      tabStripRef: useRef(null),
      tabStripOffsetRef: offsetRef,
      tabStripViewportWidthRef: useRef(0),
      tabStripContentWidthRef: useRef(0),
      tabLayoutsRef: useRef(new Map())
    }
    const keyboard = useMobileSessionKeyboardState(
      mountFixture<KeyboardScope>({ ...strip, terminals: [], setKeyboardHeight: () => {} })
    )
    const controller = mountFixture<Controller>({
      ...strip,
      ...keyboard,
      connState: 'connected',
      activeSessionTabIdRef,
      activeHandleRef: { current: null },
      switchSessionTab: (tab: { id: string }) => setActiveSessionTabId(tab.id),
      setRenameTarget,
      visibleTabs,
      terminals
    })
    return createElement(MobileSessionTabStrip, { controller, inTopBar: false })
  }
  let tree: ReturnType<typeof create> | undefined
  act(() => {
    tree = create(createElement(Harness), { createNodeMock: () => ({ scrollTo }) })
  })
  const root = tree!.root
  const tabs = root.findAll((node) => node.props.accessibilityRole === 'tab')
  const strip = root.find((node) => node.props.horizontal === true)
  // A 300px strip with tab c cut off at its right edge.
  act(() => {
    strip.props.onLayout({ nativeEvent: { layout: { width: 300 } } })
    strip.props.onContentSizeChange(TAB_IDS.length * TAB_WIDTH)
    tabs.forEach((tab: ReactTestInstance, index: number) =>
      tab.props.onLayout({ nativeEvent: { layout: { x: index * TAB_WIDTH, width: TAB_WIDTH } } })
    )
  })
  // Presses whichever tab sits under this screen x after any scroll so far.
  const tapAt = (screenX: number) =>
    act(() => tabs[Math.floor((screenX + offsetRef.current) / TAB_WIDTH)].props.onPress())
  const wait = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  return { scrollTo, setRenameTarget, tapAt, wait, tabs }
}

describe('MobileSessionTabStrip edge taps', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: (at: number) => void) =>
      setTimeout(() => cb(Date.now()), 16)
    )
    vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uses the host identity while retaining tab gestures', () => {
    const strip = mountStrip([{ handle: 'term-c', agentIdentity: 'cursor' }])
    expect(strip.tabs[2].findAll((node) => node.props.agentId === 'cursor')).toHaveLength(1)
    strip.tapAt(295)
    strip.wait(100)
    strip.tapAt(295)
    expect(strip.setRenameTarget).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'term-c' })
    )
    strip.wait(1000)
    expect(strip.scrollTo.mock.calls).toEqual([[{ x: 112, animated: true }]])
  })

  it('renames the tab a double-tap started on, then reveals its neighbour', () => {
    const strip = mountStrip()
    strip.tapAt(295)
    strip.wait(100)
    expect(strip.scrollTo).not.toHaveBeenCalled()
    strip.tapAt(295)
    expect(strip.setRenameTarget).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'term-c' })
    )
    strip.wait(1000)
    expect(strip.scrollTo.mock.calls).toEqual([[{ x: 112, animated: true }]])
  })
})
