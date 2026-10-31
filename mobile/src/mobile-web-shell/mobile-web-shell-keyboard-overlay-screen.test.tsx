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
vi.mock('../transport/host-client-hooks', mocks['../transport/host-client-hooks'])
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
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { ReactTestRenderer } from 'react-test-renderer'
import type * as ScreenModule from './MobileWebShellScreen'

let MobileWebShellScreen: typeof ScreenModule.MobileWebShellScreen

const renderScreen = (state: MobileWebShellSessionState): Promise<ReactTestRenderer> =>
  mountScreen(MobileWebShellScreen, dependencies, state)

afterEach(harness.unmountRenderedScreens)

beforeEach(async () => {
  // Each OS case starts a fresh app-lifetime keyboard observer.
  vi.resetModules()
  harness.resetScreenDependencies(dependencies)
  dependencies.keyboardListeners.clear()
  MobileWebShellScreen = (await import('./MobileWebShellScreen')).MobileWebShellScreen
})

const WINDOW = { top: 44, right: 0, bottom: 8, left: 0 }

// Keep page size under the keyboard and send height updates like native screens.
describe('a page the keyboard covers', () => {
  async function openPage(sessionId: string) {
    dependencies.client = createFakeRpcClient()
    const tree = await renderScreen(readyState(sessionId))
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0]?.props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'ready' }) }
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
      // Use observed Pixel_API_37 heights, including suggestion-strip changes while the keyboard stays open.
      for (const height of [312, 346, 0]) {
        await page.keyboard(height)
        expect(page.root().props.style[1]).toEqual({ paddingTop: 0 })
      }
      // Send native keyboard height, including iOS home indicator; leave bottom safe-area inset unchanged for page-side OS arithmetic.
      expect(page.inits()).toEqual([
        { keyboard: 0, insets: WINDOW },
        { keyboard: 312, insets: WINDOW },
        { keyboard: 346, insets: WINDOW },
        { keyboard: 0, insets: WINDOW }
      ])
    })
  }
})
