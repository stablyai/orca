import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PairScanScreen from '../app/pair-scan'
const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  replace: vi.fn(),
  platform: { OS: 'ios' },
  cameraGranted: true
}))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Platform: mocks.platform,
  Linking: {},
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: mocks.replace, back: vi.fn() }) }))
vi.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [{ granted: mocks.cameraGranted }, vi.fn()]
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft',
  Clipboard: 'Clipboard',
  QrCode: 'QrCode'
}))
vi.mock('./transport/pre-profile-pairing-coordinator', () => ({
  startPreProfilePairing: mocks.start
}))
vi.mock('./transport/host-client-hooks', () => ({ useRefreshHostClient: () => vi.fn() }))
vi.mock('./components/TextInputModal', () => ({ TextInputModal: 'TextInputModal' }))
vi.mock('./components/ConnectionLog', () => ({ ConnectionLog: () => null }))
vi.mock('./onboarding/mobile-onboarding-plan', () => ({
  loadMobileOnboardingSteps: async () => [],
  mobileOnboardingDestination: () => '/'
}))
let renderer: ReactTestRenderer | null = null
const code = (endpoint: string) =>
  btoa(
    JSON.stringify({
      v: 2,
      endpoint,
      publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      deviceToken: 'synthetic-device'
    })
  )
async function render() {
  await act(async () => {
    renderer = create(createElement(PairScanScreen), { createNodeMock: () => ({}) })
  })
  if (!renderer) {
    throw new Error('No screen')
  }
  return renderer
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.platform.OS = 'ios'
  mocks.cameraGranted = true
  mocks.start.mockImplementation(() => ({
    result: Promise.reject(new Error('Access required')),
    dispose: vi.fn(),
    timedOut: false
  }))
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})
it.each(['scan', 'paste'])(
  'offers the original secure %s code to confirmation after failure',
  async (mode) => {
    const screen = await render()
    const original =
      mode === 'scan'
        ? 'orca://pair?code=' + code('wss://orca.example')
        : code('wss://orca.example')
    await act(async () => {
      if (mode === 'scan') {
        screen.root
          .findAll((node) => String(node.type) === 'CameraView')[0]
          ?.props.onBarcodeScanned({ data: original })
      } else {
        screen.root
          .findAll((node) => String(node.type) === 'TextInputModal')[0]
          ?.props.onSubmit(original)
      }
    })
    const recovery = screen.root
      .findAllByProps({ accessibilityLabel: 'Configure edge authentication' })
      .find((node) => String(node.type) === 'Pressable')
    expect(recovery).toBeDefined()
    act(() => recovery?.props.onPress())
    expect(mocks.replace).toHaveBeenCalledWith({
      pathname: '/pair-confirm',
      params: { code: original }
    })
  }
)
it.each(['plain', 'web'])('does not offer native service headers for %s failures', async (kind) => {
  if (kind === 'web') {
    mocks.platform.OS = 'web'
  }
  const screen = await render()
  await act(async () =>
    screen.root
      .findAll((node) => String(node.type) === 'TextInputModal')[0]
      ?.props.onSubmit(code(kind === 'plain' ? 'ws://192.168.1.5:6768' : 'wss://orca.example'))
  )
  expect(
    screen.root.findAllByProps({ accessibilityLabel: 'Configure edge authentication' })
  ).toHaveLength(0)
})
it('keeps successful LAN scanning automatic', async () => {
  mocks.start.mockReturnValue({
    result: Promise.resolve({ hostId: 'host-1' }),
    dispose: vi.fn(),
    timedOut: false
  })
  const screen = await render()
  await act(async () =>
    screen.root
      .findAll((node) => String(node.type) === 'CameraView')[0]
      ?.props.onBarcodeScanned({ data: 'orca://pair?code=' + code('ws://192.168.1.5:6768') })
  )
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(mocks.replace).toHaveBeenCalledWith('/')
})

it('offers secure paste recovery even when camera permission is denied', async () => {
  mocks.cameraGranted = false
  const screen = await render()
  const original = code('wss://orca.example')
  await act(async () =>
    screen.root
      .findAll((node) => String(node.type) === 'TextInputModal')[0]
      ?.props.onSubmit(original)
  )
  const recovery = screen.root
    .findAllByProps({ accessibilityLabel: 'Configure edge authentication' })
    .find((node) => String(node.type) === 'Pressable')
  expect(recovery).toBeDefined()
  act(() => recovery?.props.onPress())
  expect(mocks.replace).toHaveBeenCalledWith({
    pathname: '/pair-confirm',
    params: { code: original }
  })
})
