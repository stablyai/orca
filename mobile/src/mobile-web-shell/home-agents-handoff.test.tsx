// A host page's Agents button hands `/?agents=<host>` to native; it must return to Home, not stack a second one.
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

const homeEntry = { key: 'entry-home', name: 'index', params: {} }
const hostEntry = {
  key: 'entry-host',
  name: 'h',
  state: {
    key: 'host-stack',
    index: 0,
    routes: [{ key: 'entry-0', name: '[hostId]/index', params: { hostId: 'host-1' } }]
  }
}

async function pageNavigates(href: string): Promise<void> {
  dependencies.rootState = { key: 'root-stack', index: 1, routes: [homeEntry, hostEntry] }
  dependencies.client = createFakeRpcClient()
  dependencies.state = harness.readyState('session-one')
  const mounted: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    mounted.tree = create(
      createElement(MobileWebShellScreen, { hostId: 'host-1', route: { pathname: '/h/host-1' } })
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
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("a page's link to Home's Agents tab", () => {
  it('returns to the Home under the host page with the desktop filter', async () => {
    await pageNavigates('/?agents=host-1')
    expect(dependencies.dismissTo.mock.calls).toEqual([['/?agents=host-1']])
    expect(dependencies.push).not.toHaveBeenCalled()
    expect(dependencies.dispatch).not.toHaveBeenCalled()
  })
})
