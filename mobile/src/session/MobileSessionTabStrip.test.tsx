import { createContext, createElement, useMemo, useRef, useState } from 'react'
import { Text } from 'react-native'
import { File, FileText, Globe, SquareTerminal } from 'lucide-react-native'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { AgentStateDot } from '../components/AgentStateDot'
import { activateMobileUiLocale, getMobileUiLocale } from '../i18n/mobile-i18n'
import {
  applyMobileColorScheme,
  getMobileColorScheme,
  paletteForScheme
} from '../theme/mobile-theme'
import { mobileSessionFrameStyles } from './mobile-session-frame-styles'
import { MobileSessionTabCardFooter } from './MobileSessionTabCardFooter'
import { MobileSessionTitleBlock } from './MobileSessionTitleBlock'
import type { NavBarButton } from '../components/nav-bar/NavBarButton'
import type * as TabModule from './MobileSessionTab'
import type * as FooterModule from './MobileSessionTabCardFooter'
import type * as TabContentModule from './mobile-session-tab-card-content'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'

type StripWork = {
  tabs: number
  content: number
  footer: number
  rows: number
  ids: number
  records: number
  measures: number
  landscape: boolean
  sideRail: boolean
  back: (() => boolean) | null
  removeAppState: ReturnType<typeof vi.fn>
}

const work = vi.hoisted((): StripWork => ({
  tabs: 0,
  content: 0,
  footer: 0,
  rows: 0,
  ids: 0,
  records: 0,
  measures: 0,
  landscape: false,
  sideRail: false,
  back: null,
  removeAppState: vi.fn()
}))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: work.removeAppState }) },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  Platform: { OS: 'web', select: () => undefined },
  Easing: { out: () => () => 0, cubic: () => 0 },
  Animated: {
    View: 'AnimatedView',
    Value: class {
      value = 0
      stopAnimation(read?: (value: number) => void) {
        read?.(this.value)
      }
      interpolate() {
        return this
      }
    },
    timing: (value: { value: number }, config: { toValue: number }) => ({
      start: () => {
        value.value = config.toValue
      }
    })
  },
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  useWindowDimensions: () => ({ width: 800, height: 600 })
}))
vi.mock('lucide-react-native', () => ({
  File: 'FileIcon',
  FileText: 'MarkdownIcon',
  Globe: 'BrowserIcon',
  ChevronLeft: 'Icon',
  Folder: 'Icon',
  GitBranch: 'Icon',
  MoreHorizontal: 'Icon',
  PanelLeftOpen: 'Icon',
  Plus: 'Icon',
  SquareTerminal: 'TerminalIcon',
  Columns2: 'Icon',
  SquareChevronRight: 'Icon'
}))
vi.mock('../navigation/use-back-claim', () => ({
  useBackClaim: (claim: (() => boolean) | null) => {
    work.back = claim
  }
}))
vi.mock('../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: () => {} }))
vi.mock('../components/MobileAgentIcon', () => ({
  MobileAgentIcon: (props: Parameters<typeof MobileAgentIcon>[0]) =>
    createElement('AgentIcon', props)
}))
vi.mock('../components/AgentStateDot', () => ({
  AgentStateDot: (props: Parameters<typeof AgentStateDot>[0]) => createElement('StateDot', props)
}))
vi.mock('../components/nav-bar/NavBarButton', () => ({
  NavBarButton: (props: Parameters<typeof NavBarButton>[0]) => createElement('HeaderButton', props)
}))
vi.mock('./mobile-session-styles', async () => {
  const { mobileSessionFrameStyles } = await import('./mobile-session-frame-styles')
  return {
    styles: {
      sessionTopBar: 'top-bar',
      get sessionMetaText() {
        return mobileSessionFrameStyles.sessionMetaText
      }
    }
  }
})
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => true }))
vi.mock('../layout/host-sidebar-reveal', () => ({ useHostSidebarReveal: () => null }))
vi.mock('../layout/use-top-chrome-space', () => ({ useTopChromeSpace: () => ({}) }))
vi.mock('../layout/use-shell-side-rail', () => ({ useShellSideRail: () => work.sideRail }))
vi.mock('./MobileSessionHeaderMoreMenu', () => ({
  MobileSessionHeaderMoreMenu: () => null
}))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isLandscapePhone: work.landscape, width: 800 })
}))
vi.mock('../transport/use-workspace-client', () => ({
  WorkspaceServerContext: createContext(undefined)
}))
vi.mock('./MobileSessionAccessoryKeys', () => ({ MobileSessionAccessoryKeys: () => null }))
vi.mock('./MobileSessionCommandDock', () => ({ sessionCommandDockShown: () => false }))
vi.mock('./MobileSessionContentRow', () => ({
  MobileSessionContentRow: () => {
    work.rows++
    return null
  }
}))
vi.mock('./MobileSessionSheets', () => ({ MobileSessionSheets: () => null }))
vi.mock('./MobileWorkerAutoCloseStrip', () => ({ MobileWorkerAutoCloseStrip: () => null }))
vi.mock('./MobileSessionTab', async (original) => {
  const actual = await original<typeof TabModule>()
  return {
    MobileSessionTab: (props: Parameters<typeof actual.MobileSessionTab>[0]) => {
      work.tabs++
      return createElement(actual.MobileSessionTab, props)
    }
  }
})
vi.mock('./MobileSessionTabCardFooter', async (original) => {
  const actual = await original<typeof FooterModule>()
  return {
    MobileSessionTabCardFooter: (
      props: Parameters<typeof actual.MobileSessionTabCardFooter>[0]
    ) => {
      work.footer++
      return createElement(actual.MobileSessionTabCardFooter, props)
    }
  }
})
vi.mock('./mobile-session-tab-card-content', async (original) => {
  const actual = await original<typeof TabContentModule>()
  return {
    mobileSessionTabCardContent: (
      ...args: Parameters<typeof actual.mobileSessionTabCardContent>
    ) => {
      work.content++
      return actual.mobileSessionTabCardContent(...args)
    }
  }
})
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

import { MobileSessionSurface } from './MobileSessionSurface'
import { AnchoredDetailCard } from '../components/AnchoredDetailCard'
import type { MobileSessionTabStrip } from './MobileSessionTabStrip'
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
  terminals: Pick<Controller['terminals'][number], 'handle' | 'agentIdentity'>[] = [],
  initialTabs: Controller['visibleTabs'] = visibleTabs
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
      renameTarget: renameOpen ? { handle: 'term', title: 'rename', isActive: true } : null,
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

describe('MobileSessionTabStrip edge taps', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    Object.assign(work, {
      tabs: 0,
      content: 0,
      footer: 0,
      rows: 0,
      ids: 0,
      records: 0,
      measures: 0,
      landscape: false,
      sideRail: false,
      back: null
    })
    work.removeAppState.mockClear()
    vi.stubGlobal('requestAnimationFrame', (cb: (at: number) => void) =>
      setTimeout(() => cb(Date.now()), 16)
    )
    vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens tab details in the compact Duo header while its title is absent', () => {
    work.sideRail = true
    const strip = mountStrip()
    expect(strip.root.findAllByType(MobileSessionTitleBlock)).toHaveLength(0)
    strip.tapAt(50)
    expect(strip.card().props.active).toBe(true)
    expect(strip.card().props.title).toBe('a')
    expect(strip.card().props.obscured).toBe(false)
    act(() => expect(work.back?.()).toBe(true))
    expect(strip.card().props.active).toBe(false)
    expect(work.back).toBeNull()
    act(() => strip.card().props.onSettled(strip.card().props.motion))
    expect(strip.root.findAllByType(AnchoredDetailCard)).toHaveLength(0)
    strip.unmount()
  })

  it('uses the host identity while retaining tab gestures', () => {
    const strip = mountStrip([{ handle: 'term-c', agentIdentity: 'cursor' }])
    expect(strip.tabs[2].findByType(MobileAgentIcon).props.agentId).toBe('cursor')
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
    act(() =>
      strip.root
        .findByProps({ accessibilityHint: 'Shows the full workspace name and where it is' })
        .props.onPress()
    )
    expect(strip.card().props.source.key).toBe('title')
    strip.tapAt(295)
    expect(strip.root.findAllByType(AnchoredDetailCard)).toHaveLength(1)
    expect(strip.tabs.map((tab) => tab.props.accessibilityState.selected)).toEqual([
      false,
      false,
      true,
      false,
      false
    ])
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

  it('reanchors B on sibling-only resize events and preserves B when old A disappears', () => {
    const strip = mountStrip([], visibleTabs.slice(0, 3))
    strip.rotate()
    const tab = (id: string) =>
      strip.root.findByProps({ accessibilityRole: 'tab', accessibilityLabel: id })
    const layout = (id: string, x: number, width: number) =>
      act(() => tab(id).props.onLayout({ nativeEvent: { layout: { x, width } } }))
    layout('a', 0, 80)
    layout('b', 80, 80)
    layout('c', 160, 120)
    strip.positions.set('b', 80)
    act(() => tab('b').props.onPress())
    const motion = strip.card().props.motion
    strip.positions.set('b', 120)
    // RNWeb observes changed sizes of A/C; position-only B and the total width emit nothing.
    layout('a', 0, 120)
    layout('c', 200, 80)
    expect(strip.card().props).toMatchObject({ motion, anchor: { trigger: { x: 120 } } })
    act(() => tab('a').props.onPress())
    strip.wait(400)
    strip.queue()
    act(() => tab('b').props.onPress())
    strip.rotate('a')
    expect(strip.root.findAllByType(AnchoredDetailCard)).toHaveLength(0)
    expect(work.back).not.toBeNull()
    strip.flush()
    expect(strip.card().props).toMatchObject({ active: true, source: { key: 'tab:b' } })
    strip.unmount()
  })

  it('keeps an empty terminal heading readable as its open row and locale change', async () => {
    const originalLocale = getMobileUiLocale()
    const empty = { ...visibleTabs[0], title: '' }
    const strip = mountStrip([], [empty])
    try {
      strip.tapAt(50)
      const source = strip.card().props.source
      const motion = strip.card().props.motion
      const now = Date.now()
      const heading = () => strip.card().findAllByType(Text)[0].props.children
      expect(heading()).toBe('Terminal')
      for (const title of ['First full shell title', '', 'Next full shell title']) {
        const row = { ...empty, title }
        strip.updateTabs([row])
        expect(heading()).toBe(title || 'Terminal')
        expect(row.title).toBe(title)
        expect(strip.card().props.active).toBe(true)
        expect(strip.card().props.source).toBe(source)
        expect(strip.card().props.motion).toBe(motion)
        expect(Date.now()).toBe(now)
        if (title === '') {
          await act(async () => activateMobileUiLocale('ja'))
          expect(heading()).toBe('ターミナル')
          expect(row.title).toBe('')
          expect(Date.now()).toBe(now)
          await act(async () => activateMobileUiLocale(originalLocale))
        }
      }
      expect(empty.title).toBe('')
    } finally {
      strip.unmount()
      await act(async () => activateMobileUiLocale(originalLocale))
    }
  })

  it('renders representative per-kind content through Surface and the real footer', () => {
    const samples: {
      tab: Controller['visibleTabs'][number]
      title: string
      program: string
      icon: typeof File | typeof MobileAgentIcon
      agentId?: string
      state?: string
      detail?: string
    }[] = [
      {
        tab: {
          ...visibleTabs[0],
          title: '✳ Fix tabs',
          agentStatus: {
            state: 'working',
            agentType: 'claude',
            paneKey: 't:l',
            prompt: '',
            updatedAt: 1000,
            stateStartedAt: 1000,
            stateHistory: []
          }
        },
        title: 'Fix tabs',
        program: 'Claude',
        icon: MobileAgentIcon,
        agentId: 'claude',
        state: 'working'
      },
      {
        tab: { ...visibleTabs[0], title: '  Full shell name · work  ' },
        title: '  Full shell name · work  ',
        program: 'Terminal',
        icon: SquareTerminal
      },
      {
        tab: {
          type: 'agent-session',
          id: 'a',
          title: '✳ Chat',
          agent: 'codex',
          sessionId: 's',
          isActive: true
        },
        title: 'Chat',
        program: 'Codex',
        icon: MobileAgentIcon,
        agentId: 'codex'
      },
      ...(['file', 'markdown'] as const).map((type) => ({
        tab: {
          type,
          id: 'a',
          title: 'note.md',
          filePath: '/docs/note.md',
          relativePath: 'docs/note.md',
          isDirty: false,
          isActive: true,
          documentVersion: '1'
        },
        title: 'note.md',
        detail: 'docs/note.md',
        program: 'Editor',
        icon: type === 'file' ? File : FileText
      })),
      {
        tab: {
          type: 'browser',
          id: 'a',
          title: 'Search',
          url: 'https://example.com/search',
          browserWorkspaceId: 'w',
          browserPageId: 'p',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          isActive: true
        },
        title: 'Search',
        program: 'example.com/search',
        icon: Globe
      }
    ]
    for (const sample of samples) {
      const strip = mountStrip([], [sample.tab])
      strip.tapAt(50)
      const card = strip.card()
      const text = card.findAllByType(Text).map((node) => node.props.children)
      expect(text).toEqual(
        sample.detail
          ? [sample.title, sample.detail, sample.program]
          : [sample.title, sample.program]
      )
      const icons = card.findAllByType(sample.icon)
      expect(icons).toHaveLength(1)
      if (sample.agentId) {
        expect(icons[0].props.agentId).toBe(sample.agentId)
      }
      expect(card.findAllByType(AgentStateDot).map((node) => node.props.state)).toEqual(
        sample.state ? [sample.state] : []
      )
      strip.unmount()
    }
  })

  it('repaints the cached footer immediately on dark-light-dark appearance changes', () => {
    const originalScheme = getMobileColorScheme()
    let strip: ReturnType<typeof mountStrip> | undefined
    try {
      act(() => applyMobileColorScheme('dark'))
      strip = mountStrip([], [{ ...visibleTabs[0], title: 'Shell' }])
      strip.tapAt(50)
      const card = strip.card()
      const footerElement = card.props.footer
      const content = card.findByType(MobileSessionTabCardFooter).props.content
      const anchor = card.props.anchor
      const now = Date.now()
      for (const scheme of ['dark', 'light', 'dark'] as const) {
        act(() => applyMobileColorScheme(scheme))
        expect(card.props.footer).toBe(footerElement)
        expect(card.findByType(MobileSessionTabCardFooter).props.content).toBe(content)
        expect(card.props.anchor).toBe(anchor)
        expect(Date.now()).toBe(now)
        expect(card.findByType(SquareTerminal).props.color).toBe(
          paletteForScheme(scheme).textSecondary
        )
        const texts = card.findAllByType(Text)
        expect(texts.map((text) => text.props.children)).toEqual(['Shell', 'Terminal'])
        expect(texts[1].props.style).toBe(mobileSessionFrameStyles.sessionMetaText)
        expect(texts[1].props.style.color).toBe(paletteForScheme(scheme).textSecondary)
      }
    } finally {
      strip?.unmount()
      act(() => applyMobileColorScheme(originalScheme))
    }
  })

  it.each([20, 200])('bounds real refresh/measurement work with %i tabs and records', (size) => {
    const tabs = Array.from({ length: size }, (_, i) => ({
      ...visibleTabs[0],
      get id() {
        work.ids++
        return `tab-${i}`
      },
      title: `tab-${i}`,
      terminal: `term-${i}`
    }))
    const terminals = tabs.map((_, i) => ({
      get handle() {
        work.records++
        return `term-${i}`
      },
      agentIdentity: 'cursor'
    }))
    const strip = mountStrip(terminals, tabs)
    const reset = () =>
      Object.assign(work, {
        tabs: 0,
        content: 0,
        footer: 0,
        rows: 0,
        ids: 0,
        records: 0,
        measures: 0
      })
    const scroll = (x: number) =>
      act(() =>
        strip.root
          .find((node) => node.props.horizontal === true)
          .props.onScroll({ nativeEvent: { contentOffset: { x } } })
      )
    strip.wait(16) // Settle the keyboard mount RAF before the clock baseline.
    // Settle the existing hidden-edge transition before measuring unchanged-edge work.
    scroll(10)
    scroll(10)
    reset()
    expect(vi.getTimerCount()).toBe(1) // Existing strip clock only, no closed-card clock.
    strip.wait(60_000)
    expect(work.content).toBe(0)
    expect(work.footer).toBe(0)
    expect(work.rows).toBe(0)
    expect(work.records).toBe(0)
    expect(work.tabs).toBe(size) // Pre-existing strip clock, linear in visible tabs.
    expect(work.ids).toBeLessThanOrEqual(8 * size)
    strip.tapAt(150)
    strip.wait(400)
    expect(vi.getTimerCount()).toBe(2)
    const motion = strip.card().props.motion
    for (const x of [10, 11, 12]) {
      strip.queue()
      reset()
      scroll(x)
      expect(work).toMatchObject({
        tabs: 0,
        content: 0,
        footer: 0,
        rows: 0,
        ids: 0,
        records: 0,
        measures: 1
      })
      strip.flush() // Measurement settlement has its own act turn.
      expect(work).toMatchObject({
        tabs: 0,
        content: 0,
        footer: 0,
        rows: 0,
        ids: 0,
        records: 0,
        measures: 3
      })
      expect(strip.card().props).toMatchObject({ motion, anchor: { trigger: { x: 100 - x } } })
      expect(strip.card().findByProps({ role: 'dialog' }).props.style[1].left).toBe(100 - x)
    }
    reset()
    strip.wait(60_000)
    expect(work).toMatchObject({ content: 1, footer: 1, rows: 0, records: 0, tabs: size })
    expect(work.ids).toBeLessThanOrEqual(8 * size)
    strip.updateTabs(
      tabs.map((tab, i) => (i === 1 ? { ...tab, title: 'Renamed current tab' } : tab))
    )
    expect(strip.card().findAllByProps({ children: 'Renamed current tab' })).toHaveLength(1)
    act(() => strip.root.find((node) => node.props.horizontal === true).props.onScrollBeginDrag())
    expect(vi.getTimerCount()).toBe(1)
    strip.unmount()
    expect(work.back).toBeNull()
    expect(work.removeAppState).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
