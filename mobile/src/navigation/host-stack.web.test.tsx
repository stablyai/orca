import type { ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

type Route = { key: string; name: string }

const stack = vi.hoisted((): { routes: Route[]; settle: (() => void) | null } => ({
  routes: [],
  settle: null
}))

vi.mock('react-native', () => ({
  View: 'View',
  StyleSheet: { create: (x: unknown) => x, absoluteFill: { position: 'absolute' } }
}))
vi.mock('expo-router', () => {
  const Navigator = ({ children }: { children: ReactNode }) => children
  Navigator.Screen = () => null
  Navigator.useContext = () => ({
    state: { routes: stack.routes },
    descriptors: Object.fromEntries(
      stack.routes.map((route) => [route.key, { render: () => route.name }])
    )
  })
  return { Navigator, usePathname: () => '/' }
})
vi.mock('../i18n/use-mobile-translation', () => ({ useMobileTranslation: () => () => '' }))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'light' }))
vi.mock('../theme/themed-styles', () => ({ themedStyleSheet: (make: () => unknown) => make() }))
vi.mock('../theme/mobile-theme', () => ({ colors: { bgBase: '#fff' } }))
vi.mock('./host-stack-screens', () => ({ HOST_STACK_SCREENS: [] }))
vi.mock('../new-workspace/overlay-page-route', () => ({ isOverlayPageRoute: () => false }))
vi.mock('./use-shell-open-target.web', () => ({ useShellOpenTarget: () => false }))
vi.mock('./use-reported-page-location.web', () => ({ useReportedPageLocation: () => {} }))
vi.mock('../mobile-web-shell/bridge/page-lifecycle/page-first-paint', () => ({
  RouteScreenPaintProvider: ({ children }: { children: ReactNode }) => children,
  reportAfterFirstPaint: () => () => {},
  useRouteScreenPaintReporter: () => () => () => {}
}))
vi.mock('./host-stack-motion.web', () => ({
  runStackMotion: ({ onSettled }: { onSettled: () => void }) => {
    stack.settle = onSettled
    return () => {}
  }
}))

const { HostStack } = await import('./host-stack.web')

let renderer: ReactTestRenderer | null = null

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  vi.stubGlobal('HTMLElement', class {})
  stack.routes = [{ key: 'home', name: 'Home' }]
  stack.settle = null
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  vi.unstubAllGlobals()
})

function views(): ReactTestInstance[] {
  return renderer!.root.findAll((node) => String(node.type) === 'View')
}

function pushFile(): void {
  stack.routes = [...stack.routes, { key: 'file', name: 'File' }]
  act(() => renderer!.update(<HostStack animation="default" />))
}

it('keeps pointer events on while a pushed screen slides in', () => {
  act(() => {
    renderer = create(<HostStack animation="default" />)
  })
  pushFile()

  expect(stack.settle).not.toBeNull()
  // iOS WebKit leaves an iframe that loads under pointer-events none unscrollable by touch for good.
  expect(views().filter((view) => view.props.pointerEvents === 'none')).toEqual([])
})

it('covers taps only until the slide settles', () => {
  act(() => {
    renderer = create(<HostStack animation="default" />)
  })
  const shield = () => renderer!.root.findAllByProps({ testID: 'host-stack-tap-shield' })
  expect(shield()).toHaveLength(0)

  pushFile()
  expect(shield()).toHaveLength(1)
  // Drawn after the screens, so it sits above both the entering and the covered one.
  const top = views()[0]!.children.at(-1)
  expect(typeof top === 'string' ? top : top?.props.testID).toBe('host-stack-tap-shield')
  expect(shield()[0]!.props.style).toMatchObject({ zIndex: 1 })

  act(() => stack.settle!())
  expect(shield()).toHaveLength(0)
})
