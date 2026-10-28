// Folding a foldable while its host-area page shows a session must keep that session, not drop to the list beneath.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = await vi.hoisted(async () => await import('./mobile-web-shell-screen-test-harness'))
const dependencies = vi.hoisted(() => harness.createScreenDependencies())
const { screenModuleMocks } = await vi.hoisted(
  async () => await import('./mobile-web-shell-screen-test-mocks')
)
const mocks = vi.hoisted(() => screenModuleMocks(dependencies))
const device = vi.hoisted(() => ({ width: 951, height: 669 }))

vi.mock('react-native', () => ({
  ...mocks['react-native'](),
  useWindowDimensions: () => ({ width: device.width, height: device.height })
}))
vi.mock('expo-router', mocks['expo-router'])
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
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { MobileWebShellScreen } from './MobileWebShellScreen'

const HOST = '/h/host-1'
const DETAIL = '/h/host-1/session/wt-1'
const UNFOLDED = { width: 951, height: 669 }
const COVER = { width: 466, height: 678 }

const hostEntry = { key: 'entry-0', name: '[hostId]/index', params: { hostId: 'host-1' } }
const sessionEntry = {
  key: 'entry-1',
  name: '[hostId]/session/[worktreeId]',
  params: { hostId: 'host-1', worktreeId: 'wt-1' }
}

function stackOf(routes: readonly (typeof hostEntry | typeof sessionEntry)[]) {
  const hostStack = { key: 'host-stack', index: routes.length - 1, routes: [...routes] }
  return { key: 'root-stack', index: 0, routes: [{ key: 'h', name: 'h', state: hostStack }] }
}

async function foldAfterPageShows(location: string | null, focused = true): Promise<void> {
  Object.assign(device, UNFOLDED)
  dependencies.ownsHostArea = true
  dependencies.screenFocused = focused
  // Unfocused means a native session was pushed over this host-route shell.
  dependencies.rootState = focused ? stackOf([hostEntry]) : stackOf([hostEntry, sessionEntry])
  dependencies.client = createFakeRpcClient()
  dependencies.state = harness.readyState('session-one')
  dependencies.pageRoutes = ['/h/[hostId]', '/h/[hostId]/session/[worktreeId]']
  const screen = () =>
    createElement(MobileWebShellScreen, { hostId: 'host-1', route: { pathname: HOST } })
  const mounted: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    mounted.tree = create(screen())
  })
  const view = mounted.tree?.root.findAll((node) => String(node.type) === 'ShellViewProbe')[0]
  await act(async () => {
    view?.props.onBridgeMessage({ nativeEvent: { json: clientFrame({ type: 'ready' }) } })
    if (location !== null) {
      view?.props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'notify', name: 'location', href: location }) }
      })
    }
  })
  Object.assign(device, COVER)
  dependencies.ownsHostArea = false
  await act(async () => {
    mounted.tree?.update(screen())
  })
  act(() => mounted.tree?.unmount())
}

beforeEach(() => {
  harness.resetScreenDependencies(dependencies)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('folding while the host-area page shows a session', () => {
  it('reopens that session natively on the cover screen', async () => {
    await foldAfterPageShows(DETAIL)
    expect(dependencies.push.mock.calls).toEqual([[DETAIL]])
  })

  it('stays on the list when the page was showing the list', async () => {
    await foldAfterPageShows(HOST)
    expect(dependencies.push).not.toHaveBeenCalled()
  })

  it('leaves the stack alone from a host-route shell covered by a pushed session', async () => {
    await foldAfterPageShows(HOST, false)
    expect(dependencies.push).not.toHaveBeenCalled()
    expect(dependencies.dispatch).not.toHaveBeenCalled()
  })

  it('stays on the list for an older page that never reports where it is', async () => {
    await foldAfterPageShows(null)
    expect(dependencies.push).not.toHaveBeenCalled()
  })
})
