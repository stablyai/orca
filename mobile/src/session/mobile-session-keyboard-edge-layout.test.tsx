import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
const layout = vi.hoisted(() => ({ sideRail: false, padAvailable: false, os: 'ios' }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))
vi.mock('../platform/host-os', () => ({ hostOs: () => layout.os }))
vi.mock('../layout/use-shell-side-rail', () => ({
  useShellSideRail: () => layout.sideRail,
  useDirectionPadAvailable: () => layout.padAvailable
}))
import { useMobileSessionPresentation } from './use-mobile-session-presentation'

type Scope = Parameters<typeof useMobileSessionPresentation>[0]
let tree: ReactTestRenderer | undefined
afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
  Object.assign(layout, { sideRail: false, padAvailable: false, os: 'ios' })
})
it.each(['ios', 'android'])(
  'keeps the keyboard boundary aligned across Duo posture changes on %s',
  (os) => {
    layout.os = os
    const scope = mountFixture<Scope>({
      client: null,
      connState: 'connected',
      activeHandle: 'a',
      terminalsLoaded: true,
      visibleTabs: [{ id: 'a', type: 'terminal', terminal: 'a' }],
      insets: { top: 0, left: 0, right: 0, bottom: 34 },
      keyboardHeight: 334,
      terminalKeyboardMetrics: new Map(),
      terminalFrameRef: { current: null },
      toastOpacityRef: { current: {} }
    })
    function Screen({ keyboardHeight, view }: { keyboardHeight: number; view: string }) {
      const scene = mountFixture<Scope>({
        showNativeChat: view === 'chat',
        activeMarkdownTab: view === 'markdown' ? {} : null,
        activeFileTab: view === 'file' ? {} : null,
        activeBrowserTab: view === 'browser' ? {} : null
      })
      const value = useMobileSessionPresentation({ ...scope, ...scene, keyboardHeight })
      return createElement('KeyboardBoundary', value)
    }
    const render = (keyboardHeight = 334, view = 'terminal') =>
      act(() => {
        if (tree) {
          tree.update(createElement(Screen, { keyboardHeight, view }))
        } else {
          tree = create(createElement(Screen, { keyboardHeight, view }))
        }
      })
    const lift = () =>
      tree!.root.find((node) => String(node.type) === 'KeyboardBoundary').props.keyboardLift
    render()
    expect(lift()).toBe(os === 'ios' ? 300 : 334)
    layout.sideRail = true
    render()
    expect(lift()).toBe(334)
    layout.sideRail = false
    layout.padAvailable = true
    render()
    expect(lift()).toBe(334)
    for (const view of ['chat', 'browser', 'markdown', 'file']) {
      render(334, view)
      expect(lift()).toBe(os === 'ios' ? 300 : 334)
      render()
      expect(lift()).toBe(334)
    }
    render(0)
    expect(lift()).toBe(0)
    layout.padAvailable = false
    render()
    expect(lift()).toBe(os === 'ios' ? 300 : 334)
  }
)
