import { afterEach, beforeEach, expect, it, vi } from 'vitest'

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
  renderScreen,
  updateScreen
} from './mobile-web-shell-screen-test-harness'
import { readBridgeHostMessage } from './bridge/bridge-envelope'
import { BRIDGE_BACK_CLAIM_NOTIFY } from './bridge/bridge-page-back'
import { MobileWebShellScreen } from './MobileWebShellScreen'
import type { ReactTestRenderer } from 'react-test-renderer'

afterEach(harness.unmountRenderedScreens)
beforeEach(() => harness.resetScreenDependencies(dependencies))

async function receive(tree: ReactTestRenderer, frame: Record<string, unknown>): Promise<void> {
  await act(async () => {
    byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
      nativeEvent: { json: clientFrame(frame) }
    })
  })
}

function backFrames(): string[] {
  return dependencies.posted.filter((json) => {
    const read = readBridgeHostMessage(json)
    return read.ok && read.message.type === 'back'
  })
}

it('leaves Back to the native screen after handoff and resumes the page claim on return', async () => {
  dependencies.platform = 'android'
  dependencies.client = createFakeRpcClient()
  const state = readyState('host-area-session')
  const tree = await renderScreen(MobileWebShellScreen, dependencies, state)
  await receive(tree, { type: 'ready' })
  await receive(tree, { type: 'notify', name: BRIDGE_BACK_CLAIM_NOTIFY, claimed: true })
  expect(dependencies.reportPageBackClaim).toHaveBeenCalledWith(true)
  dependencies.backClaimed = true
  await updateScreen(MobileWebShellScreen, dependencies, tree, state)

  const handler = dependencies.backHandlers.get('hardwareBackPress')
  if (!handler) {
    throw new Error('Claimed page has no Back handler')
  }
  expect(handler()).toBe(true)
  expect(backFrames()).toHaveLength(1)

  await receive(tree, { type: 'notify', name: 'navigate', href: '/terminal-settings' })
  expect(dependencies.push).toHaveBeenCalledWith('/terminal-settings')
  dependencies.screenFocused = false
  expect(handler()).toBe(false)
  expect(backFrames()).toHaveLength(1)

  dependencies.screenFocused = true
  expect(handler()).toBe(true)
  expect(backFrames()).toHaveLength(2)
})
