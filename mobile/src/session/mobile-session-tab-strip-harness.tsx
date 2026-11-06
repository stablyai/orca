import { createElement, useMemo, useRef, useState } from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { AnchoredDetailCard } from '../components/AnchoredDetailCard'
import { MobileSessionSurface } from './MobileSessionSurface'
import type { MobileSessionTabStrip } from './MobileSessionTabStrip'
import { useMobileSessionKeyboardState } from './use-mobile-session-keyboard-state'

type Controller = Parameters<typeof MobileSessionTabStrip>[0]['controller']
type KeyboardScope = Parameters<typeof useMobileSessionKeyboardState>[0]

const TAB_WIDTH = 100

export type TabStripHarnessWork = {
  landscape: boolean
  measures: number
}

export function mountMobileSessionTabStrip(
  work: TabStripHarnessWork,
  terminals: Pick<Controller['terminals'][number], 'handle' | 'agentIdentity'>[] = [],
  initialTabs: Controller['visibleTabs'],
  extras: {
    showRecentSessionCardsAction?: boolean
    showRecentSessionCards?: boolean
    setShowRecentSessionCards?: Controller['setShowRecentSessionCards']
    worktreeId?: string
  } = {}
) {
  const scrollTo = vi.fn()
  const setRenameTarget = vi.fn()
  const offsetRef = { current: 0 }
  let queued = false
  const measurements: (() => void)[] = []
  let suppliedTabs = initialTabs
  const positions = new Map(initialTabs.map((tab, index) => [tab.id, index * TAB_WIDTH]))
  function Harness({ inTopBar = false, removed = '' }: { inTopBar?: boolean; removed?: string }) {
    const [renameOpen, setRenameOpen] = useState(false)
    work.landscape = inTopBar
    const tabs = useMemo(
      () => suppliedTabs.filter((tab) => tab.id !== removed),
      [removed, suppliedTabs]
    )
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
      presentedConnState: 'connected',
      showConnectionRetry: false,
      connectionEscalated: false,
      worktreeName: 'workspace',
      bulkCloseConfirm: { visible: false },
      isFloatingWorkspaceRoute: true,
      renameTarget: renameOpen
        ? { handle: 'term', title: activeSessionTabId, isActive: true }
        : null,
      activeSessionTabIdRef,
      activeHandleRef: { current: null },
      switchSessionTab: (tab: { id: string }) => setActiveSessionTabId(tab.id),
      setRenameTarget: (target) => {
        setRenameTarget(target)
        setRenameOpen(true)
      },
      visibleTabs: tabs,
      terminals,
      ...extras
    })
    return createElement(MobileSessionSurface, { controller })
  }
  let tree: ReturnType<typeof create> | undefined
  act(() => {
    tree = create(createElement(Harness), {
      createNodeMock: (node) => {
        const props = node.props
        if (!props || typeof props !== 'object') {
          throw new Error('expected host props')
        }
        const label =
          'accessibilityLabel' in props && typeof props.accessibilityLabel === 'string'
            ? props.accessibilityLabel
            : ''
        const layer = 'pointerEvents' in props && props.pointerEvents === 'box-none'
        return {
          scrollTo,
          measureInWindow: (
            done: (x: number, y: number, width: number, height: number) => void
          ) => {
            work.measures++
            const complete = () => {
              if ('accessibilityRole' in props && props.accessibilityRole === 'tab') {
                done((positions.get(label) ?? 0) - offsetRef.current, 50, 100, 40)
              } else if (layer) {
                done(0, 0, 800, 600)
              } else if ('style' in props && props.style === 'top-bar') {
                done(0, 10, 800, 40)
              } else {
                done(0, 50, 300, 40)
              }
            }
            if (queued && layer) {
              measurements.push(complete)
            } else {
              complete()
            }
          }
        }
      }
    })
  })
  const root = tree!.root
  const tabs = root.findAll((node) => node.props.accessibilityRole === 'tab')
  const strip = root.find((node) => node.props.horizontal === true)
  act(() => {
    root
      .findByProps({ pointerEvents: 'box-none' })
      .props.onLayout({ nativeEvent: { layout: { width: 800, height: 600 } } })
    strip.props.onLayout({ nativeEvent: { layout: { width: 300 } } })
    strip.props.onContentSizeChange(initialTabs.length * TAB_WIDTH)
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
    card: () => root.findByType(AnchoredDetailCard),
    queue: () => {
      queued = true
    },
    flush: () =>
      act(() => {
        queued = false
        measurements.splice(0).forEach((done) => done())
      }),
    updateTabs: (next: Controller['visibleTabs']) => {
      suppliedTabs = next
      act(() => tree!.update(createElement(Harness)))
    },
    rotate: (removed = '') =>
      act(() => tree!.update(createElement(Harness, { inTopBar: true, removed }))),
    unmount: () => act(() => tree!.unmount())
  }
}
