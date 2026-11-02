import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as ReservedRegions from '../layout/reserved-regions'
import type * as SideRail from '../layout/side-rail'

const harness = await vi.hoisted(async () => await import('./mobile-web-shell-screen-test-harness'))
const dependencies = vi.hoisted(() => harness.createScreenDependencies())
const geometry = vi.hoisted(() => ({
  root: { x: 669, y: 0, width: 669, height: 951 },
  insets: { top: 84, right: 0, bottom: 34, left: 0 },
  regions: { divisions: [], occlusions: [{ x: 470, y: 0, width: 199, height: 84 }] }
}))
vi.mock('../layout/reserved-regions', async (importOriginal) => ({
  ...(await importOriginal<typeof ReservedRegions>()),
  useReservedRegions: () => geometry.regions
}))
vi.mock('../layout/side-rail', async (importOriginal) => ({
  ...(await importOriginal<typeof SideRail>()),
  useSideRailStrip: () => null,
  useSideRailDirectionPadAvailable: () => true
}))

const { screenModuleMocks } = await vi.hoisted(
  async () => await import('./mobile-web-shell-screen-test-mocks')
)
const mocks = vi.hoisted(() => screenModuleMocks(dependencies))
vi.mock('react-native', () => ({
  ...mocks['react-native'](),
  useWindowDimensions: () => ({ width: 669, height: 951 })
}))
vi.mock('expo-clipboard', mocks['expo-clipboard'])
vi.mock('expo-haptics', mocks['expo-haptics'])
vi.mock('expo-document-picker', mocks['expo-document-picker'])
vi.mock('@orca/expo-two-way-audio', mocks['@orca/expo-two-way-audio'])
vi.mock('expo-keep-awake', mocks['expo-keep-awake'])
vi.mock('expo-image-picker', mocks['expo-image-picker'])
vi.mock('expo-file-system', mocks['expo-file-system'])
vi.mock('lucide-react-native', mocks['lucide-react-native'])
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => geometry.insets }))
vi.mock('expo-router', mocks['expo-router'])
vi.mock('../../modules/orca-mobile-web-shell/src', mocks['../../modules/orca-mobile-web-shell/src'])
vi.mock('../app-update/use-wall-app-update', mocks['../app-update/use-wall-app-update'])
vi.mock('../transport/host-client-hooks', mocks['../transport/host-client-hooks'])
vi.mock('./use-page-host-snapshot', mocks['./use-page-host-snapshot'])
vi.mock('./use-mobile-web-shell-session', mocks['./use-mobile-web-shell-session'])

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { byName, readyState } from './mobile-web-shell-screen-test-harness'
import { readBridgeHostMessage } from './bridge/bridge-envelope'
import { MobileWebShellScreen } from './MobileWebShellScreen'
import { topChromeSpace } from '../layout/top-chrome-space'

let tree: ReactTestRenderer | undefined
beforeEach(() => {
  harness.resetScreenDependencies(dependencies)
  dependencies.client = createFakeRpcClient()
  dependencies.state = readyState('root-layout')
  geometry.root.x = 669
})
afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
})
async function mount() {
  await act(async () => {
    tree = create(
      createElement(MobileWebShellScreen, { hostId: 'host-1', route: { pathname: '/h/host-1' } }),
      {
        createNodeMock: () => ({
          measureInWindow: (
            callback: (x: number, y: number, width: number, height: number) => void
          ) => {
            const { x, y, width, height } = geometry.root
            callback(x, y, width, height)
          }
        })
      }
    )
  })
  await act(async () => {
    byName(tree!, 'ShellViewProbe')[0].props.onBridgeMessage({
      nativeEvent: { json: clientFrame({ type: 'ready' }) }
    })
  })
}
async function layoutRoot() {
  await act(async () => {
    tree!.root.find((node) => node.props.testID === 'mobile-web-shell-ready').props.onLayout?.()
  })
}
async function layoutWebView() {
  await act(async () => {
    byName(tree!, 'ShellViewProbe')[0].props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 669, height: 951 } }
    })
  })
}
function pageChromeSpace() {
  const init = dependencies.posted
    .flatMap((json) => {
      const read = readBridgeHostMessage(json)
      return read.ok && read.message.type === 'init' ? [read.message] : []
    })
    .at(-1)
  return topChromeSpace(
    { x: 0, y: 0, width: 669, height: 88 },
    init?.safeAreaInsets?.top ?? 0,
    init?.pageGeometry?.occlusions ?? []
  )
}

it('restores the header beside the status area when only the shell root moves', async () => {
  await mount()
  await layoutWebView()
  expect(pageChromeSpace()).toBeNull()

  geometry.root.x = 0
  await layoutRoot()
  expect(pageChromeSpace()).toEqual({ left: 0, right: 199, minHeight: 84 })
  expect(dependencies.lifecycle).toEqual(['mount:root-layout'])
})

it('waits for the child frame when the root lays out first', async () => {
  geometry.root.x = 0
  await mount()
  await layoutRoot()
  expect(pageChromeSpace()).toBeNull()
  await layoutWebView()
  expect(pageChromeSpace()).toEqual({ left: 0, right: 199, minHeight: 84 })
})
