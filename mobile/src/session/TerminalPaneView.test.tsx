import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'

const hosts = vi.hoisted(() => {
  const component = (name: string) => {
    const Host = (props: { children?: ReactNode }) => props.children ?? null
    Host.displayName = name
    return Host
  }
  return {
    View: component('View'),
    Text: component('Text'),
    Pressable: component('Pressable'),
    TerminalWebView: component('TerminalWebView')
  }
})
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  View: hosts.View,
  Text: hosts.Text,
  Pressable: hosts.Pressable,
  ActivityIndicator: hosts.View,
  Animated: { View: hosts.View },
  StyleSheet: {
    create: <T,>(value: T) => value,
    absoluteFillObject: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }
  }
}))
vi.mock('../terminal/TerminalWebView', () => ({ TerminalWebView: hosts.TerminalWebView }))
vi.mock('../storage/preferences', () => ({ saveTerminalTextScale: () => Promise.resolve() }))
vi.mock('../browser/MobileBrowserPane', () => ({ MobileBrowserPane: () => null }))
vi.mock('./MobileNativeChatOverlay', () => ({ MobileNativeChatOverlay: () => null }))
vi.mock('./MobileSessionFileReader', () => ({ FileReader: () => null }))
vi.mock('./MobileSessionMarkdownReader', () => ({ MarkdownReader: () => null }))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('../transport/use-host-profile', () => ({ useHostProfile: () => null }))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]) }
})
import { TerminalPaneView } from './TerminalPaneView'
import { MobileSessionActiveContent } from './MobileSessionActiveContent'
import { terminalPaneViewport } from './mobile-terminal-pane-layout'

type Props = Parameters<typeof TerminalPaneView>[0]

it.each([0, 1])(
  'keeps stacked pane %i visible above a tall keyboard and preserves its measured terminal frame',
  (index) => {
    const onFrame = vi.fn()
    const base = mountFixture<Props>({
      handle: `term-${index}`,
      active: true,
      visible: true,
      splitIndex: index,
      splitDirection: 'column',
      splitFrame: { width: 390, height: 500 },
      keyboardInset: 0,
      keyboardLift: 0,
      textScale: 1,
      onFrame,
      onRef: vi.fn()
    })
    let renderer!: ReturnType<typeof create>
    try {
      act(() => {
        renderer = create(createElement(TerminalPaneView, base))
      })
      const views = () => renderer.root.findAllByType(hosts.View)
      expect(views()[2].props.style.height).toBe(222)
      act(() => {
        renderer.update(
          createElement(TerminalPaneView, { ...base, keyboardInset: 300, keyboardLift: 150 })
        )
      })
      const [outer, clip, measured] = views()
      const outerStyle = Object.assign({}, ...outer.props.style.filter(Boolean))
      expect(outerStyle.top).toBe(index * 100)
      expect(outerStyle.height).toBe(100)
      expect(clip.props.style.overflow).toBe('hidden')
      expect(measured.props.style.height).toBe(222)
      act(() => {
        measured.props.onLayout({ nativeEvent: { layout: { width: 390, height: 222 } } })
      })
      expect(onFrame).toHaveBeenLastCalledWith(`term-${index}`, { width: 390, height: 222 })
      const terminal = renderer.root.findByType(hosts.TerminalWebView)
      const terminalStyle = Object.assign({}, ...terminal.props.style.filter(Boolean))
      const bottom =
        outerStyle.top + 28 + measured.props.style.height + terminalStyle.transform[0].translateY
      expect(bottom).toBe(index * 100 + 100)
      expect(bottom).toBeGreaterThan(outerStyle.top + 28)
      expect(bottom).toBeLessThanOrEqual(200)
    } finally {
      act(() => renderer?.unmount())
    }
  }
)

it.each(['stacked', 'side-by-side'] as const)(
  'keeps visible %s terminal content above the keyboard independently of input focus',
  (layout) => {
    const frame = { width: 900, height: 500 }
    const terminalHeight = layout === 'stacked' ? 222 : 472
    const visibleHeight = layout === 'stacked' ? 72 : 172
    const expectedLift = layout === 'stacked' ? 150 : 300
    const geometry = new Map()
    for (const handle of ['a', 'b', 'c']) {
      terminalPaneViewport(geometry, handle).terminalFrameRef.current = {
        width: layout === 'stacked' ? 900 : 450,
        height: terminalHeight
      }
    }
    const controller = mountFixture<Parameters<typeof MobileSessionActiveContent>[0]['controller']>(
      {
        terminals: ['a', 'b', 'c'].map((handle) => ({ handle, title: handle })),
        activeHandle: 'a',
        terminalSplitActive: true,
        terminalSplitLayout: layout,
        visibleTerminalHandles: ['a', 'b'],
        terminalKeyboardMetrics: new Map([
          ['a', { rows: 10, rowPitch: 5, cursorY: 2, contentBottomRow: 2, altScreen: false }],
          [
            'b',
            {
              rows: 40,
              rowPitch: terminalHeight / 40,
              cursorY: 39,
              contentBottomRow: 39,
              altScreen: true
            }
          ]
        ]),
        getTerminalPaneViewport: (handle) => terminalPaneViewport(geometry, handle),
        keyboardLift: 0,
        activeTerminalKeyboardLift: 0,
        notifyTerminalFrame: vi.fn(),
        dictation: { isRecording: false },
        nativeChatSendError: { message: null, clear: vi.fn() }
      }
    )
    let renderer!: ReturnType<typeof create>
    const render = (activeHandle: string, keyboardLift: number) => {
      const element = createElement(MobileSessionActiveContent, {
        controller: { ...controller, activeHandle, keyboardLift }
      })
      act(() => {
        if (renderer) {
          renderer.update(element)
        } else {
          renderer = create(element)
        }
      })
    }
    const terminalStyle = (handle: string) => {
      const pane = renderer.root
        .findAllByType(TerminalPaneView)
        .find((item) => item.props.handle === handle)!
      const terminal = pane.findByType(hosts.TerminalWebView)
      return Object.assign({}, ...terminal.props.style.filter(Boolean))
    }
    try {
      render('a', 0)
      act(() => {
        renderer.root
          .findAllByType(hosts.View)[0]
          .props.onLayout({ nativeEvent: { layout: frame } })
      })
      for (const focused of ['a', 'b', 'a']) {
        render(focused, 300)
        expect(terminalStyle('a').transform).toBeUndefined()
        expect(terminalStyle('b').transform).toEqual([{ translateY: -expectedLift }])
        // A pane never shown has not mounted its terminal yet.
        expect(renderer.root.findAllByType(hosts.TerminalWebView)).toHaveLength(2)
        for (const pane of renderer.root.findAllByType(TerminalPaneView).slice(0, 2)) {
          const [outer, clip, measured] = pane.findAllByType(hosts.View)
          const outerStyle = Object.assign({}, ...outer.props.style.filter(Boolean))
          expect(outerStyle.height - 28).toBe(visibleHeight)
          expect(clip.props.style.overflow).toBe('hidden')
          expect(measured.props.style.height).toBe(terminalHeight)
        }
        expect(terminalHeight + terminalStyle('b').transform[0].translateY).toBe(visibleHeight)
      }
      render('a', 0)
      expect(terminalStyle('a').transform).toBeUndefined()
      expect(terminalStyle('b').transform).toBeUndefined()
      expect(renderer.root.findAllByType(hosts.TerminalWebView)).toHaveLength(2)
    } finally {
      act(() => renderer?.unmount())
    }
  }
)
