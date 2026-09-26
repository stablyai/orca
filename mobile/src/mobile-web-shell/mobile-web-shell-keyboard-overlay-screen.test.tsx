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
import { BRIDGE_KEYBOARD_INSET_ACCEPT } from './bridge/bridge-keyboard-inset'
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

const WINDOW = { top: 44, right: 0, bottom: 8, left: 0 }

/**
 * A page that reads the keyboard from `init` is covered by it like a native screen: the view keeps
 * its size, and the page is told the height on every keyboard event.
 */
describe('a page the keyboard covers', () => {
  async function openPage(sessionId: string) {
    dependencies.client = createFakeRpcClient()
    dependencies.pageOwnsSafeArea = true
    dependencies.pageReadsKeyboardInset = true
    const tree = await renderScreen(readyState(sessionId))
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0]?.props.onBridgeMessage({
        nativeEvent: {
          json: clientFrame({
            type: 'ready',
            accepts: [
              BRIDGE_ROUTE_UPDATE_ACCEPT,
              BRIDGE_SAFE_AREA_ACCEPT,
              BRIDGE_KEYBOARD_INSET_ACCEPT
            ]
          })
        }
      })
    })
    const root = () => tree.root.find((node) => node.props.testID === 'mobile-web-shell-ready')
    const inits = () =>
      dependencies.posted.flatMap((json) => {
        const read = readBridgeHostMessage(json)
        return read.ok && read.message.type === 'init'
          ? [{ keyboard: read.message.keyboardInset ?? 0, insets: read.message.safeAreaInsets }]
          : []
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
    return { root, inits, keyboard }
  }

  for (const platform of ['ios', 'android'] as const) {
    it(`never shortens the view, and publishes show, a height change and hide (${platform})`, async () => {
      dependencies.platform = platform
      const page = await openPage(`session-overlay-${platform}`)
      // Pixel_API_37: 312 up, 346 with the suggestion strip, then closed. The inset tracks each, so
      // a keyboard that changes height while open leaves no gap above it.
      for (const height of [312, 346, 0]) {
        await page.keyboard(height)
        expect(page.root().props.style[1]).toEqual({ paddingTop: 0, paddingBottom: 0 })
      }
      // The keyboard's own height, as native screens read it; the bottom inset stays the window's.
      expect(page.inits()).toEqual([
        { keyboard: 0, insets: WINDOW },
        { keyboard: 312, insets: WINDOW },
        { keyboard: 346, insets: WINDOW },
        { keyboard: 0, insets: WINDOW }
      ])
    })
  }

  it('still shortens the view for an older page that cannot read the keyboard', async () => {
    dependencies.platform = 'android'
    dependencies.client = createFakeRpcClient()
    dependencies.pageOwnsSafeArea = true
    const tree = await renderScreen(readyState('session-older-keyboard'))
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0]?.props.onBridgeMessage({
        nativeEvent: {
          json: clientFrame({
            type: 'ready',
            accepts: [BRIDGE_ROUTE_UPDATE_ACCEPT, BRIDGE_SAFE_AREA_ACCEPT]
          })
        }
      })
    })
    await act(async () => {
      dependencies.keyboardListeners.get('keyboardDidShow')?.({ endCoordinates: { height: 336 } })
    })
    const root = tree.root.find((node) => node.props.testID === 'mobile-web-shell-ready')
    expect(root.props.style[1]).toEqual({ paddingTop: 0, paddingBottom: 344 })
    // The first `init` and the insets move; the keyboard itself sends nothing to this page.
    const inits = dependencies.posted.filter((json) => {
      const read = readBridgeHostMessage(json)
      return read.ok && read.message.type === 'init'
    })
    expect(inits).toHaveLength(2)
  })
})
