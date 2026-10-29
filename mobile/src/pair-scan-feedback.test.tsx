import { createElement, useEffect, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PairScanScreen from '../app/pair-scan'
import { findAllByHostType, findByHostType } from './test-support/react-test-renderer-host-nodes'

const mocks = vi.hoisted(() => {
  const callbacks: {
    appState: null | ((state: string) => void)
    reject: null | ((error: Error) => void)
  } = { appState: null, reject: null }
  return {
    ...callbacks,
    permission: { granted: false, canAskAgain: false },
    cameraListeners: new Set<(permission: { granted: boolean; canAskAgain: boolean }) => void>(),
    requestPermission: vi.fn(),
    getPermission: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    start: vi.fn(),
    parse: vi.fn()
  }
})
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Linking: { openSettings: vi.fn() },
  StyleSheet: { create: (value: unknown) => value, absoluteFillObject: {} },
  AppState: {
    addEventListener: (_event: string, callback: (state: string) => void) => {
      mocks.appState = callback
      return { remove: () => {} }
    }
  }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ back: mocks.back, replace: mocks.replace }) }))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', Clipboard: 'Icon', QrCode: 'Icon' }))
vi.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => {
    const [value, setValue] = useState(mocks.permission)
    useEffect(() => {
      mocks.cameraListeners.add(setValue)
      return () => {
        mocks.cameraListeners.delete(setValue)
      }
    }, [])
    return [value, mocks.requestPermission, mocks.getPermission]
  }
}))
vi.mock('./transport/pairing', () => ({
  decodePairingUrl: mocks.parse,
  parsePairingCode: mocks.parse
}))
vi.mock('./transport/pre-profile-pairing-coordinator', () => ({
  startPreProfilePairing: mocks.start
}))
vi.mock('./transport/host-client-hooks', () => ({ useRefreshHostClient: () => () => {} }))
vi.mock('./components/TextInputModal', () => ({ TextInputModal: 'TextInputModal' }))
vi.mock('./components/ConnectionLog', () => ({ ConnectionLog: 'ConnectionLog' }))
vi.mock('./onboarding/mobile-onboarding-plan', () => ({
  loadMobileOnboardingSteps: async () => [],
  mobileOnboardingDestination: () => '/h/test'
}))
vi.mock('./theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('./theme/themed-styles', () => ({
  themedStyleSheet: (factory: () => unknown) => factory()
}))
let renderer: ReactTestRenderer | null = null
beforeEach(() => {
  mocks.permission = { granted: false, canAskAgain: false }
  mocks.appState = null
  mocks.cameraListeners.clear()
  mocks.getPermission.mockReset().mockImplementation(async () => {
    for (const listener of mocks.cameraListeners) {
      listener(mocks.permission)
    }
    return mocks.permission
  })
  mocks.parse
    .mockReset()
    .mockReturnValue({ endpoint: 'ws://test', deviceToken: 'token', publicKeyB64: 'key' })
  mocks.start.mockReset().mockImplementation(() => ({
    result: new Promise((_resolve, reject) => {
      mocks.reject = reject
    }),
    timedOut: false,
    dispose() {}
  }))
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})
async function render() {
  await act(async () => {
    renderer = create(createElement(PairScanScreen), { createNodeMock: () => ({}) })
  })
}
async function paste(code = 'valid') {
  await act(async () => findByHostType(root(), 'TextInputModal').props.onSubmit(code))
}
function root() {
  if (!renderer) {
    throw new Error('Screen is not mounted')
  }
  return renderer.root
}
const screen = () =>
  findAllByHostType(root(), 'Text')
    .map((node) => node.props.children)
    .join(' ')
it.each([true, false])(
  'reports an invalid pasted code without camera access (canAskAgain=%s)',
  async (canAskAgain) => {
    mocks.permission.canAskAgain = canAskAgain
    mocks.parse.mockReturnValue(null)
    await render()
    await paste('invalid')
    expect(screen()).toContain('Not a valid pairing code')
  }
)
it('shows connecting feedback for a pasted code without camera permission', async () => {
  await render()
  await paste()
  expect(mocks.start).toHaveBeenCalledOnce()
  expect(screen()).toContain('Connecting…')
})
it('shows pairing failure and retry after a pasted code without camera permission', async () => {
  await render()
  await paste()
  await act(async () => mocks.reject!(new Error('network unreachable')))
  expect(screen()).toContain('Pairing failed: network unreachable')
  expect(screen()).toContain('Try Again')
  const retry = findAllByHostType(root(), 'Pressable').find((node) =>
    findAllByHostType(node, 'Text').some((text) => text.props.children === 'Try Again')
  )
  if (!retry) {
    throw new Error('Retry action is missing')
  }
  await act(async () => retry.props.onPress())
  expect(screen()).toContain('Camera Access Disabled')
  expect(screen()).toContain('Paste code instead')
})
it('refreshes denied camera access after granting it in Settings', async () => {
  await render()
  mocks.permission = { granted: true, canAskAgain: false }
  await act(async () => mocks.appState?.('active'))
  expect(mocks.getPermission).toHaveBeenCalledOnce()
  expect(findAllByHostType(root(), 'CameraView')).toHaveLength(1)
})
it('control: shows connecting feedback with camera permission', async () => {
  mocks.permission = { granted: true, canAskAgain: true }
  await render()
  await paste()
  expect(screen()).toContain('Connecting…')
})

it('keeps denied access retryable if a foreground permission read fails', async () => {
  await render()
  mocks.getPermission.mockRejectedValueOnce(new Error('permission service unavailable'))
  await act(async () => mocks.appState?.('active'))
  expect(screen()).toContain('Camera Access Disabled')
  mocks.permission = { granted: true, canAskAgain: false }
  await act(async () => mocks.appState?.('active'))
  expect(findAllByHostType(root(), 'CameraView')).toHaveLength(1)
})
