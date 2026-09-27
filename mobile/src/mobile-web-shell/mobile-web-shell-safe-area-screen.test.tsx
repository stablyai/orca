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
import { BRIDGE_ROUTE_UPDATE_ACCEPT } from './bridge/bridge-route-update'
import { BRIDGE_SAFE_AREA_ACCEPT } from './bridge/bridge-safe-area-insets'
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
 * A page that pads for the system bars itself gets the whole window, like a native screen: it
 * paints under both bars and its SafeAreaViews pad by the insets `init` carries.
 */
describe('a page that owns its safe area', () => {
  async function openPage(sessionId: string, accepts: readonly string[]) {
    dependencies.client = createFakeRpcClient()
    const tree = await renderScreen(readyState(sessionId))
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0]?.props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'ready', accepts }) }
      })
    })
    const root = () => tree.root.find((node) => node.props.testID === 'mobile-web-shell-ready')
    const initInsets = () =>
      dependencies.posted.flatMap((json) => {
        const read = readBridgeHostMessage(json)
        return read.ok && read.message.type === 'init' ? [read.message.safeAreaInsets ?? null] : []
      })
    const keyboard = async (height: number) => {
      await act(async () => {
        const ios = dependencies.platform === 'ios'
        const name =
          height > 0
            ? ios
              ? 'keyboardWillShow'
              : 'keyboardDidShow'
            : ios
              ? 'keyboardWillHide'
              : 'keyboardDidHide'
        dependencies.keyboardListeners.get(name)?.({ endCoordinates: { height } })
      })
    }
    return { tree, root, initInsets, keyboard }
  }
  const ownedPage = (sessionId: string) => {
    dependencies.pageOwnsSafeArea = true
    return openPage(sessionId, [BRIDGE_ROUTE_UPDATE_ACCEPT, BRIDGE_SAFE_AREA_ACCEPT])
  }
  const WINDOW = { top: 44, right: 0, bottom: 8, left: 0 }

  it('draws the view edge-to-edge and hands the page the insets it now sits under', async () => {
    const page = await ownedPage('session-owned')
    expect(page.root().props.style[1]).toEqual({ paddingTop: 0, paddingBottom: 0 })
    expect(page.initInsets()).toEqual([WINDOW])
  })

  it('re-sends init with no bottom inset while the keyboard ends the view', async () => {
    const page = await ownedPage('session-owned-keyboard')
    await page.keyboard(336)
    // The view ends at the keyboard's top, so nothing of it is under the gesture bar.
    expect(page.root().props.style[1]).toEqual({ paddingTop: 0, paddingBottom: 336 })
    await page.keyboard(0)
    expect(page.root().props.style[1]).toEqual({ paddingTop: 0, paddingBottom: 0 })
    expect(page.initInsets()).toEqual([WINDOW, { ...WINDOW, bottom: 0 }, WINDOW])
  })

  it('does the same on Android, where the IME strip is measured above the gesture bar', async () => {
    dependencies.platform = 'android'
    const page = await ownedPage('session-owned-android')
    await page.keyboard(336)
    expect(page.root().props.style[1]).toEqual({ paddingTop: 0, paddingBottom: 344 })
    await page.keyboard(0)
    expect(page.root().props.style[1]).toEqual({ paddingTop: 0, paddingBottom: 0 })
    expect(page.initInsets()).toEqual([WINDOW, { ...WINDOW, bottom: 0 }, WINDOW])
  })

  it('gives the status bar strip to the update banner while it shows', async () => {
    dependencies.updateNotice = 'update-failed'
    const page = await ownedPage('session-owned-banner')
    expect(page.root().props.style[1]).toEqual({ paddingTop: 44, paddingBottom: 0 })
    expect(page.initInsets()).toEqual([{ ...WINDOW, top: 0 }])
    await act(async () => {
      byName(page.tree, 'Pressable')
        .find((node) => node.props.accessibilityLabel === 'Dismiss notice')
        ?.props.onPress()
    })
    expect(page.root().props.style[1]).toEqual({ paddingTop: 0, paddingBottom: 0 })
    expect(page.initInsets()).toEqual([{ ...WINDOW, top: 0 }, WINDOW])
  })

  it('sends no second init to an older page that takes route updates but not insets', async () => {
    const page = await openPage('session-older', [BRIDGE_ROUTE_UPDATE_ACCEPT])
    await page.keyboard(336)
    await page.keyboard(0)
    expect(page.root().props.style[1]).toEqual({ paddingTop: 44, paddingBottom: 8 })
    expect(page.initInsets()).toHaveLength(1)
  })
})
