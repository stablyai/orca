import { createElement, Fragment, useRef, useState } from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  useWindowDimensions: () => ({ width: 800, height: 600 })
}))
vi.mock('lucide-react-native', () => ({
  File: 'Icon',
  FileText: 'Icon',
  Globe: 'Icon',
  Plus: 'Icon',
  SquareTerminal: 'Icon'
}))
vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: () => {} }))
vi.mock('../hooks/use-now', () => ({ useNow: () => 0 }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
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

import { useSessionTitleCard } from './use-session-title-card'
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
  title: id,
  isActive: id === 'a'
}))

function mountStrip(
  terminals: Pick<Controller['terminals'][number], 'handle' | 'agentIdentity'>[] = []
) {
  const scrollTo = vi.fn()
  const setRenameTarget = vi.fn()
  const offsetRef = { current: 0 }
  let queued = false
  const measurements: (() => void)[] = []
  const positions = new Map(TAB_IDS.map((id, index) => [id, index * TAB_WIDTH]))
  function Harness({ inTopBar = false, removed = '' }: { inTopBar?: boolean; removed?: string }) {
    const [renameOpen, setRenameOpen] = useState(false)
    const tabs = visibleTabs.filter((tab) => tab.id !== removed)
    const details = useSessionTitleCard(inTopBar, renameOpen, tabs)
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
      setRenameTarget: (target) => {
        setRenameTarget(target)
        setRenameOpen(true)
      },
      visibleTabs: tabs,
      terminals
    })
    const stripView = createElement(MobileSessionTabStrip, { controller, inTopBar, details })
    return createElement(
      Fragment,
      null,
      createElement(
        'View',
        { ref: details.barRef, testID: 'top-bar' },
        inTopBar ? stripView : null
      ),
      inTopBar ? null : stripView,
      createElement(
        'View',
        { ref: details.openerRef, testID: 'title', onPress: details.toggle },
        createElement('Text', { ref: details.titleRef })
      ),
      createElement(
        'View',
        { ref: details.layerRef, testID: 'layer', onLayout: details.onLayout },
        details.visual
          ? createElement('View', {
              testID: 'card',
              ...details.visual,
              active: details.active,
              onSettled: details.onSettled,
              dismiss: details.dismiss
            })
          : null
      )
    )
  }
  let tree: ReturnType<typeof create> | undefined
  act(() => {
    tree = create(createElement(Harness), {
      createNodeMock: (node) => ({
        scrollTo,
        measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => {
          const complete = () => {
            if (node.props.accessibilityRole === 'tab') {
              done(
                (positions.get(node.props.accessibilityLabel) ?? 0) - offsetRef.current,
                50,
                100,
                40
              )
            } else if (node.props.testID === 'layer') {
              done(0, 0, 800, 600)
            } else if (node.props.testID === 'top-bar') {
              done(0, 10, 800, 40)
            } else {
              done(0, 50, 300, 40)
            }
          }
          if (queued && node.props.testID === 'layer') {
            measurements.push(complete)
          } else {
            complete()
          }
        }
      })
    })
  })
  const root = tree!.root
  const tabs = root.findAll((node) => node.props.accessibilityRole === 'tab')
  const strip = root.find((node) => node.props.horizontal === true)
  act(() => {
    strip.props.onLayout({ nativeEvent: { layout: { width: 300 } } })
    strip.props.onContentSizeChange(TAB_IDS.length * TAB_WIDTH)
    tabs.forEach((tab: ReactTestInstance, index: number) =>
      tab.props.onLayout({ nativeEvent: { layout: { x: index * TAB_WIDTH, width: TAB_WIDTH } } })
    )
  })
  const tapAt = (screenX: number) =>
    act(() => tabs[Math.floor((screenX + offsetRef.current) / TAB_WIDTH)].props.onPress())
  const wait = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  return {
    scrollTo,
    setRenameTarget,
    tapAt,
    wait,
    tabs,
    root,
    positions,
    card: () => root.findByProps({ testID: 'card' }),
    queue: () => {
      queued = true
    },
    flush: () =>
      act(() => {
        queued = false
        measurements.splice(0).forEach((done) => done())
      }),
    rotate: (removed = '') =>
      act(() => tree!.update(createElement(Harness, { inTopBar: true, removed }))),
    unmount: () => act(() => tree!.unmount())
  }
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
    strip.unmount()
  })

  it('keeps one card through selection, reveal, movement, reparenting and stale results', () => {
    const strip = mountStrip()
    const scroll = () => strip.root.find((node) => node.props.horizontal === true)
    const press = (id: string) =>
      act(() =>
        strip.root.findByProps({ accessibilityRole: 'tab', accessibilityLabel: id }).props.onPress()
      )
    act(() => strip.root.findByProps({ testID: 'title' }).props.onPress())
    expect(strip.card().props.source.key).toBe('title')
    strip.tapAt(295)
    expect(strip.root.findAllByProps({ testID: 'card' })).toHaveLength(1)
    expect(strip.card().props.source.key).toBe('tab:c')
    const entryMotion = strip.card().props.motion
    strip.wait(400)
    act(() => scroll().props.onScroll({ nativeEvent: { contentOffset: { x: 112 } } }))
    expect(strip.card().props).toMatchObject({
      active: true,
      motion: entryMotion,
      anchor: { trigger: { x: 88 }, top: 90 }
    })
    strip.positions.set('c', 240)
    act(() =>
      strip.root
        .findByProps({ accessibilityRole: 'tab', accessibilityLabel: 'c' })
        .props.onLayout({ nativeEvent: { layout: { x: 240, width: 100 } } })
    )
    expect(strip.card().props.anchor.trigger.x).toBe(128)
    strip.queue()
    act(() => scroll().props.onContentSizeChange(600))
    strip.rotate()
    strip.flush()
    expect(strip.card().props).toMatchObject({
      active: true,
      source: { key: 'tab:c' },
      anchor: { top: 50 }
    })
    strip.wait(400)
    press('b')
    expect(strip.card().props.source.key).toBe('tab:b')
    strip.wait(400)
    press('b')
    const exiting = strip.card().props.motion
    expect(strip.card().props.active).toBe(false)
    press('a')
    act(() => strip.card().props.onSettled(exiting))
    expect(strip.card().props).toMatchObject({ active: true, source: { key: 'tab:a' } })
    strip.queue()
    act(() => scroll().props.onContentSizeChange(650))
    act(() => scroll().props.onScrollBeginDrag())
    strip.flush()
    expect(strip.card().props.active).toBe(false)
    strip.wait(400)
    press('c')
    strip.queue()
    act(() => scroll().props.onContentSizeChange(700))
    strip.rotate('c')
    strip.flush()
    expect(strip.card().props.active).toBe(false)
    strip.wait(400)
    press('b')
    strip.queue()
    act(() => scroll().props.onContentSizeChange(750))
    strip.wait(100)
    press('b')
    strip.flush()
    expect(strip.setRenameTarget).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'term-b' })
    )
    expect(strip.card().props.active).toBe(false)
    strip.unmount()
  })
})
