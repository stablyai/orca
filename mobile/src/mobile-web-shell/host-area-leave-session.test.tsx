/**
 * Leaving a detail session for the host route: the page's back chevron (`leaveSession`, which
 * replaces to `/h/<host>` when nothing is below it) and the missing-worktree bounce
 * (`/h/<host>?notice=…`). That hop reaches the shell, which must land on one host route rather than
 * stack a second host-area session on the session.
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
vi.mock('../transport/host-client-hooks', mocks['../transport/host-client-hooks'])
vi.mock('./use-page-host-snapshot', mocks['./use-page-host-snapshot'])
vi.mock('./use-mobile-web-shell-session', mocks['./use-mobile-web-shell-session'])

import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { MobileWebShellScreen } from './MobileWebShellScreen'
import type { NativeStackState } from './native-stack-return'

const HOST = '/h/host-1'
const DETAIL = '/h/host-1/session/wt-1'
const BOUNCE = '/h/host-1?notice=worktree-missing'
const IPAD = { width: 1180, height: 820 }
const PHONE = { width: 390, height: 844 }

/** A stack entry: the route's pathname and its search, as the native stack holds them. */
type Entry = string

/** The entries as the navigation container holds them: the host stack inside the root one. */
function rootStateOf(stack: readonly Entry[]): NativeStackState {
  const routes = stack.map((entry, index) => {
    const [path = '', search = ''] = entry.split('?')
    const [, , hostId = '', area, worktreeId] = path.split('/')
    const query = Object.fromEntries(new URLSearchParams(search))
    return area === undefined
      ? { key: `entry-${index}`, name: '[hostId]/index', params: { hostId, ...query } }
      : {
          key: `entry-${index}`,
          name: `[hostId]/${area}/[worktreeId]`,
          params: { hostId, worktreeId: worktreeId ?? '', ...query }
        }
  })
  const hostStack = { key: 'host-stack', index: routes.length - 1, routes }
  return { key: 'root-stack', index: 0, routes: [{ key: 'h', name: 'h', state: hostStack }] }
}

/**
 * The native stack the screen's calls act on, with expo-router 55's semantics: `push` adds, a
 * dispatched `POP` removes that many, and `dismissTo` is react-navigation's POP_TO — pop back to
 * the nearest entry of that route and take the new params, or replace the current entry when there
 * is none below it.
 */
function applied(stack: readonly Entry[]): Entry[] {
  const next = [...stack]
  for (const [href] of dependencies.push.mock.calls) {
    next.push(String(href))
  }
  for (const [action] of dependencies.dispatch.mock.calls) {
    next.splice(next.length - action.payload.count)
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
async function hopFromSession(
  viewport: { width: number; height: number },
  stack: readonly Entry[],
  href: string
) {
  device.width = viewport.width
  device.height = viewport.height
  dependencies.rootState = rootStateOf(stack)
  dependencies.client = createFakeRpcClient()
  dependencies.state = harness.readyState('session-one')
  dependencies.pageRoutes = ['/h/[hostId]', '/h/[hostId]/session/[worktreeId]']
  const mounted: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    mounted.tree = create(
      createElement(MobileWebShellScreen, {
        hostId: 'host-1',
        route: { pathname: DETAIL }
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
  harness.unmountRenderedScreens()
  vi.clearAllMocks()
})

describe('leaving a wide detail session for its host route', () => {
  it('returns to the host-area session below it, so Back does not reopen the session', async () => {
    await hopFromSession(IPAD, [HOST, DETAIL], HOST)
    expect(applied([HOST, DETAIL])).toEqual([HOST])
  })

  it('carries the bounce notice to that host route, and still stacks nothing', async () => {
    await hopFromSession(IPAD, [HOST, DETAIL], BOUNCE)
    expect(applied([HOST, DETAIL])).toEqual([BOUNCE])
  })

  it('lands on one host route from a cold deep link, with nothing below the session', async () => {
    await hopFromSession(IPAD, [DETAIL], BOUNCE)
    expect(applied([DETAIL])).toEqual([BOUNCE])
  })
})

describe('the same hop on a phone', () => {
  it('returns to the host route below rather than stacking a second one', async () => {
    await hopFromSession(PHONE, [HOST, DETAIL], HOST)
    expect(device.dismissTo).not.toHaveBeenCalled()
    expect(applied([HOST, DETAIL])).toEqual([HOST])
  })

  it('pushes a route the stack does not hold, such as another worktree', async () => {
    const other = '/h/host-1/session/wt-2'
    await hopFromSession(PHONE, [HOST, DETAIL], other)
    expect(applied([HOST, DETAIL])).toEqual([HOST, DETAIL, other])
  })

  it('pops back to the home screen via dismissTo when exiting to /', async () => {
    await hopFromSession(PHONE, ['/', HOST], '/')
    expect(device.dismissTo).toHaveBeenCalledWith('/')
    expect(applied(['/', HOST])).toEqual(['/'])
  })
})

const FAILED = {
  kind: 'failed' as const,
  reason: 'document-load-failed' as const,
  retriedOnce: true
}

function shellViews(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAll((node) => String(node.type) === 'ShellViewProbe')
}

describe('a host view that leaves ready', () => {
  it('clears the native retention slot after the failed view unmounts', async () => {
    dependencies.pathname = HOST
    const tree = await harness.renderScreen(
      MobileWebShellScreen,
      dependencies,
      harness.readyState('session-one')
    )
    const mounted = shellViews(tree)
    expect(mounted).toHaveLength(1)
    expect(mounted[0]?.props.retainsSlot).toBe(true)
    expect(dependencies.clearRetainedNativeSlot).not.toHaveBeenCalled()

    await harness.updateScreen(MobileWebShellScreen, dependencies, tree, FAILED)

    expect(shellViews(tree)).toEqual([])
    expect(
      tree.root.findAll((node) => node.props.testID === 'mobile-web-shell-failed')
    ).toHaveLength(1)
    expect(dependencies.clearRetainedNativeSlot).toHaveBeenCalledTimes(1)
  })

  it('does not clear the parked host slot when a child route fails', async () => {
    dependencies.pathname = '/h/host-1/accounts'
    const tree = await harness.renderScreen(
      MobileWebShellScreen,
      dependencies,
      harness.readyState('session-one')
    )
    const mounted = shellViews(tree)
    expect(mounted).toHaveLength(1)
    expect(mounted[0]?.props.retainsSlot).toBe(false)

    await harness.updateScreen(MobileWebShellScreen, dependencies, tree, FAILED)

    expect(shellViews(tree)).toEqual([])
    expect(dependencies.clearRetainedNativeSlot).not.toHaveBeenCalled()
  })
})
