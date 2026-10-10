/**
 * Leaving a detail session for the host route on a wide layout: the page's back chevron
 * (`leaveSession`, which replaces to `/h/<host>` when nothing is below it) and the missing-worktree
 * bounce (`/h/<host>?notice=…`). Under a page that owns the host area that hop reaches the shell,
 * which must land on one host route rather than stack a second host-area session on the session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = await vi.hoisted(async () => await import('./mobile-web-shell-screen-test-harness'))
const dependencies = vi.hoisted(() => harness.createScreenDependencies())
const { screenModuleMocks } = await vi.hoisted(
  async () => await import('./mobile-web-shell-screen-test-mocks')
)
const mocks = vi.hoisted(() => screenModuleMocks(dependencies))
const device = vi.hoisted(() => ({ width: 390, height: 844, dismissTo: vi.fn() }))

vi.mock('react-native', () => ({
  ...mocks['react-native'](),
  useWindowDimensions: () => ({ width: device.width, height: device.height })
}))
vi.mock('expo-router', () => {
  const base = mocks['expo-router']()
  return {
    ...base,
    useRouter: () => ({ ...base.useRouter(), dismissTo: device.dismissTo })
  }
})
vi.mock('expo-clipboard', mocks['expo-clipboard'])
vi.mock('expo-haptics', mocks['expo-haptics'])
vi.mock('expo-document-picker', mocks['expo-document-picker'])
vi.mock('@orca/expo-two-way-audio', mocks['@orca/expo-two-way-audio'])
vi.mock('expo-keep-awake', mocks['expo-keep-awake'])
vi.mock('expo-image-picker', mocks['expo-image-picker'])
vi.mock('expo-file-system', mocks['expo-file-system'])
vi.mock('lucide-react-native', mocks['lucide-react-native'])
vi.mock('react-native-safe-area-context', mocks['react-native-safe-area-context'])
vi.mock('../../modules/orca-mobile-web-shell/src', mocks['../../modules/orca-mobile-web-shell/src'])
vi.mock('../app-update/use-wall-app-update', mocks['../app-update/use-wall-app-update'])
vi.mock('../transport/client-context', mocks['../transport/client-context'])
vi.mock('./use-page-host-snapshot', mocks['./use-page-host-snapshot'])
vi.mock('./use-mobile-web-shell-session', mocks['./use-mobile-web-shell-session'])

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { MobileWebShellScreen } from './MobileWebShellScreen'

const HOST = '/h/host-1'
const DETAIL = '/h/host-1/session/wt-1'
const BOUNCE = '/h/host-1?notice=worktree-missing'
const IPAD = { width: 1180, height: 820 }
const PHONE = { width: 390, height: 844 }

/** A stack entry: the route's pathname and its search, as the native stack holds them. */
type Entry = string

/**
 * The native stack the screen's calls act on, with expo-router 55's semantics: `push` adds,
 * `dismissTo` is react-navigation's POP_TO — pop back to the nearest entry of that route and take
 * the new params, or replace the current entry when there is none below it.
 */
function applied(stack: readonly Entry[]): Entry[] {
  const next = [...stack]
  for (const [href] of dependencies.push.mock.calls) {
    next.push(String(href))
  }
  for (const [href] of device.dismissTo.mock.calls) {
    const target = String(href)
    const route = target.split('?')[0]
    const found = next.findLastIndex((entry) => entry.split('?')[0] === route)
    if (found === -1) {
      next.splice(-1, 1, target)
    } else {
      next.splice(found, next.length - found, target)
    }
  }
  return next
}

/** The session page on screen, asking the shell for `href`. */
async function hopFromSession(viewport: { width: number; height: number }, href: string) {
  device.width = viewport.width
  device.height = viewport.height
  dependencies.client = createFakeRpcClient()
  dependencies.state = harness.readyState('session-one')
  dependencies.pageRoutes = ['/h/[hostId]', '/h/[hostId]/session/[worktreeId]']
  const mounted: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    mounted.tree = create(
      createElement(MobileWebShellScreen, {
        hostId: 'host-1',
        route: { pathname: DETAIL },
        fallback: null
      })
    )
  })
  const view = mounted.tree?.root.findAll((node) => String(node.type) === 'ShellViewProbe')[0]
  await act(async () => {
    view?.props.onBridgeMessage({ nativeEvent: { json: clientFrame({ type: 'ready' }) } })
    view?.props.onBridgeMessage({
      nativeEvent: { json: clientFrame({ type: 'notify', name: 'navigate', href }) }
    })
  })
  act(() => mounted.tree?.unmount())
}

beforeEach(() => {
  harness.resetScreenDependencies(dependencies)
  device.dismissTo.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('leaving a wide detail session for its host route', () => {
  it('returns to the host-area session below it, so Back does not reopen the session', async () => {
    await hopFromSession(IPAD, HOST)
    expect(applied([HOST, DETAIL])).toEqual([HOST])
  })

  it('carries the bounce notice to that host route, and still stacks nothing', async () => {
    await hopFromSession(IPAD, BOUNCE)
    expect(applied([HOST, DETAIL])).toEqual([BOUNCE])
  })

  it('lands on one host route from a cold deep link, with nothing below the session', async () => {
    await hopFromSession(IPAD, BOUNCE)
    expect(applied([DETAIL])).toEqual([BOUNCE])
  })
})

describe('the same hop on a phone', () => {
  it('pushes, as it always has', async () => {
    await hopFromSession(PHONE, HOST)
    expect(device.dismissTo).not.toHaveBeenCalled()
    expect(applied([HOST, DETAIL])).toEqual([HOST, DETAIL, HOST])
  })
})
