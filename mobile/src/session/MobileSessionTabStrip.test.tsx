import { createElement, useRef, useState } from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable'
}))
vi.mock('lucide-react-native', () => ({
  File: 'Icon',
  FileText: 'Icon',
  Globe: 'Icon',
  Plus: 'Icon',
  SquareTerminal: 'Icon'
}))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: () => {} }))
vi.mock('../hooks/use-now', () => ({ useNow: () => 0 }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('../components/AgentStateDot', () => ({ AgentStateDot: () => null }))
vi.mock('./MobileSessionHeaderIconButton', () => ({ MobileSessionHeaderIconButton: () => null }))
vi.mock('./QuickCommandsTabButton', () => ({ QuickCommandsTabButton: () => null }))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('../platform/keyboard-persisting-taps', () => ({ useKeyboardPersistingTaps: () => null }))
vi.mock('../platform/keyboard-occlusion', () => ({
  useSoftKeyboard: () => ({ height: 0, visible: false })
}))
vi.mock('../terminal/terminal-viewport-refit', () => ({
  useTerminalViewportRefit: () => ({ notifyKeyboardVisibility: () => {} })
}))
vi.mock('../worktree/last-visited-worktree-repo', () => ({ writeLastVisitedWorktree: () => {} }))

import { MobileSessionTabStrip } from './MobileSessionTabStrip'
import { useMobileSessionKeyboardState } from './use-mobile-session-keyboard-state'

type Controller = Parameters<typeof MobileSessionTabStrip>[0]['controller']
type KeyboardScope = Parameters<typeof useMobileSessionKeyboardState>[0]

const TAB_IDS = ['a', 'b', 'c', 'd', 'e']
const TAB_WIDTH = 100
const visibleTabs = TAB_IDS.map((id) => ({
  type: 'terminal' as const,
  id,
  terminal: `term-${id}`,
  title: id
}))

// The real activation reveal runs, so switching tabs scrolls the strip as it does in the app.
function mountStrip() {
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
      visibleTabs
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
  return { scrollTo, setRenameTarget, tapAt, wait }
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
