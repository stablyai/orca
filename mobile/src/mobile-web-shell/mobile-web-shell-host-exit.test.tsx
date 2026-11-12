import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = await vi.hoisted(async () => await import('./mobile-web-shell-screen-test-harness'))
const dependencies = vi.hoisted(() => harness.createScreenDependencies())
const { screenModuleMocks } = await vi.hoisted(
  async () => await import('./mobile-web-shell-screen-test-mocks')
)
const mocks = vi.hoisted(() => screenModuleMocks(dependencies))

vi.mock('react-native', mocks['react-native'])
vi.mock('expo-router', mocks['expo-router'])
vi.mock('expo-clipboard', mocks['expo-clipboard'])
vi.mock('expo-haptics', mocks['expo-haptics'])
vi.mock('expo-document-picker', mocks['expo-document-picker'])
vi.mock('@orca/expo-two-way-audio', mocks['@orca/expo-two-way-audio'])
vi.mock('expo-keep-awake', mocks['expo-keep-awake'])
vi.mock('expo-image-picker', mocks['expo-image-picker'])
vi.mock('expo-file-system', mocks['expo-file-system'])
vi.mock('../device-store/device-store', mocks['../device-store/device-store'])
vi.mock('lucide-react-native', mocks['lucide-react-native'])
vi.mock('react-native-safe-area-context', mocks['react-native-safe-area-context'])
vi.mock('../../modules/orca-mobile-web-shell/src', mocks['../../modules/orca-mobile-web-shell/src'])
vi.mock('../app-update/use-wall-app-update', mocks['../app-update/use-wall-app-update'])
vi.mock(
  '../transport/connection/host-client-hooks',
  mocks['../transport/connection/host-client-hooks']
)
vi.mock('./use-page-host-snapshot', mocks['./use-page-host-snapshot'])
vi.mock('./use-mobile-web-shell-session', mocks['./use-mobile-web-shell-session'])

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { MobileWebShellScreen } from './MobileWebShellScreen'

const SESSION_PATH = '/h/host-1/session/wt-1'

const directSessionFromHomeState = {
  key: 'root-stack',
  index: 1,
  routes: [
    { key: 'home', name: 'index' },
    {
      key: 'h',
      name: 'h',
      state: {
        key: 'host-stack',
        index: 0,
        routes: [
          {
            key: 'session-0',
            name: '[hostId]/session/[worktreeId]',
            params: { hostId: 'host-1', worktreeId: 'wt-1' }
          }
        ]
      }
    }
  ]
}

async function notifySessionNavigate(href: string, replace?: boolean): Promise<void> {
  dependencies.pathname = SESSION_PATH
  dependencies.client = createFakeRpcClient()
  dependencies.state = harness.readyState('session-direct')
  dependencies.pageRoutes = ['/h/[hostId]/session/[worktreeId]']
  const mounted: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    mounted.tree = create(
      createElement(MobileWebShellScreen, {
        hostId: 'host-1',
        route: { pathname: SESSION_PATH }
      })
    )
  })
  const view = mounted.tree?.root.findAll((node) => String(node.type) === 'ShellViewProbe')[0]
  await act(async () => {
    view?.props.onBridgeMessage({ nativeEvent: { json: clientFrame({ type: 'ready' }) } })
    view?.props.onBridgeMessage({
      nativeEvent: {
        json: clientFrame({
          type: 'notify',
          name: 'navigate',
          href,
          ...(replace === undefined ? {} : { replace })
        })
      }
    })
  })
  act(() => mounted.tree?.unmount())
}

beforeEach(() => {
  harness.resetScreenDependencies(dependencies)
})

afterEach(() => {
  harness.unmountRenderedScreens()
  vi.clearAllMocks()
})

describe('leaving a session whose host list was skipped', () => {
  it.each([true, undefined])(
    'pops back to the opener when replace is %s instead of opening the host workspace list',
    async (replace) => {
      dependencies.rootState = directSessionFromHomeState
      dependencies.canGoBack = true

      await notifySessionNavigate('/h/host-1', replace)

      expect(dependencies.back).toHaveBeenCalledTimes(1)
      expect(dependencies.dismissTo).not.toHaveBeenCalled()
    }
  )

  it('still dismisses to the host route when carrying a notice query', async () => {
    dependencies.rootState = directSessionFromHomeState
    dependencies.canGoBack = true

    await notifySessionNavigate('/h/host-1?notice=worktree-missing', true)

    expect(dependencies.dismissTo).toHaveBeenCalledWith('/h/host-1?notice=worktree-missing')
    expect(dependencies.back).not.toHaveBeenCalled()
  })

  it('replaces a cold deep link with the host route when nothing sits underneath', async () => {
    dependencies.rootState = {
      key: 'root-stack',
      index: 0,
      routes: [directSessionFromHomeState.routes[1]]
    }
    dependencies.canGoBack = false

    await notifySessionNavigate('/h/host-1', true)

    expect(dependencies.dismissTo).toHaveBeenCalledWith('/h/host-1')
    expect(dependencies.back).not.toHaveBeenCalled()
  })
})
