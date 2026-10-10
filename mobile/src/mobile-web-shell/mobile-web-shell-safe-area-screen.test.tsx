import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = await vi.hoisted(async () => await import('./mobile-web-shell-screen-test-harness'))
const dependencies = vi.hoisted(() => harness.createScreenDependencies())

const { screenModuleMocks } = await vi.hoisted(
  async () => await import('./mobile-web-shell-screen-test-mocks')
)
const mocks = vi.hoisted(() => screenModuleMocks(dependencies))
vi.mock('react-native', mocks['react-native'])
vi.mock('expo-clipboard', mocks['expo-clipboard'])
vi.mock('expo-haptics', mocks['expo-haptics'])
vi.mock('expo-document-picker', mocks['expo-document-picker'])
vi.mock('@orca/expo-two-way-audio', mocks['@orca/expo-two-way-audio'])
vi.mock('expo-keep-awake', mocks['expo-keep-awake'])
vi.mock('expo-image-picker', mocks['expo-image-picker'])
vi.mock('expo-file-system', mocks['expo-file-system'])
vi.mock('lucide-react-native', mocks['lucide-react-native'])
vi.mock('react-native-safe-area-context', mocks['react-native-safe-area-context'])
vi.mock('expo-router', mocks['expo-router'])
vi.mock('../../modules/orca-mobile-web-shell/src', mocks['../../modules/orca-mobile-web-shell/src'])
vi.mock('../app-update/use-wall-app-update', mocks['../app-update/use-wall-app-update'])
vi.mock('../transport/client-context', mocks['../transport/client-context'])
vi.mock('./use-page-host-snapshot', mocks['./use-page-host-snapshot'])
vi.mock('./use-mobile-web-shell-session', mocks['./use-mobile-web-shell-session'])

import { act } from 'react-test-renderer'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import {
  byName,
  readyState,
  renderScreen as mountScreen
} from './mobile-web-shell-screen-test-harness'
import { readBridgeHostMessage } from './bridge/bridge-envelope'
import { MobileWebShellScreen } from './MobileWebShellScreen'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { ReactTestRenderer } from 'react-test-renderer'

const renderScreen = (state: MobileWebShellSessionState): Promise<ReactTestRenderer> =>
  mountScreen(MobileWebShellScreen, dependencies, state)

afterEach(harness.unmountRenderedScreens)

beforeEach(() => {
  harness.resetScreenDependencies(dependencies)
})

/**
 * Every page pads for the system bars itself and gets the whole window, like a native screen: it
 * paints under both bars and its SafeAreaViews pad by the insets `init` carries.
 */
describe('a page that owns its safe area', () => {
  async function openPage(sessionId: string) {
    dependencies.client = createFakeRpcClient()
    const tree = await renderScreen(readyState(sessionId))
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0]?.props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'ready' }) }
      })
    })
    const root = () => tree.root.find((node) => node.props.testID === 'mobile-web-shell-ready')
    const initInsets = () =>
      dependencies.posted.flatMap((json) => {
        const read = readBridgeHostMessage(json)
        return read.ok && read.message.type === 'init' ? [read.message.safeAreaInsets ?? null] : []
      })
    return { tree, root, initInsets }
  }
  // A `ready` that declares nothing: every page the shell serves reads the insets.
  const ownedPage = openPage
  const WINDOW = { top: 44, right: 0, bottom: 8, left: 0 }

  it('draws the view edge-to-edge and hands the page the insets it now sits under', async () => {
    const page = await ownedPage('session-owned')
    expect(page.root().props.style[1]).toEqual({ paddingTop: 0 })
    expect(page.initInsets()).toEqual([WINDOW])
  })

  it('gives the status bar strip to the update banner while it shows', async () => {
    dependencies.updateNotice = 'update-failed'
    const page = await ownedPage('session-owned-banner')
    expect(page.root().props.style[1]).toEqual({ paddingTop: 44 })
    expect(page.initInsets()).toEqual([{ ...WINDOW, top: 0 }])
    const dismiss = byName(page.tree, 'Pressable').find(
      (node) => node.props.accessibilityLabel === 'Dismiss notice'
    )
    expect(dismiss).toBeDefined()
    await act(async () => {
      dismiss?.props.onPress()
    })
    expect(page.root().props.style[1]).toEqual({ paddingTop: 0 })
    expect(page.initInsets()).toEqual([{ ...WINDOW, top: 0 }, WINDOW])
  })
})
