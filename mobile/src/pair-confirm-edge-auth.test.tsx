import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PairConfirmScreen from '../app/pair-confirm'

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  code: '',
  platform: { OS: 'ios' }
}))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  ScrollView: 'ScrollView',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  ActivityIndicator: 'ActivityIndicator',
  BackHandler: { addEventListener: () => ({ remove() {} }) },
  Keyboard: { addListener: () => ({ remove() {} }) },
  Platform: mocks.platform,
  StyleSheet: { create: (styles: unknown) => styles },
  findNodeHandle: () => null
}))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ code: mocks.code }),
  useRouter: () => ({ replace: mocks.replace }),
  useFocusEffect: () => {}
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'ChevronLeft' }))
vi.mock('./transport/pre-profile-pairing-coordinator', () => ({
  startPreProfilePairing: mocks.start
}))
vi.mock('./transport/pairing-edge-auth-attempt', () => ({ startPairingWithEdgeAuth: mocks.start }))
vi.mock('./transport/host-client-hooks', () => ({ useRefreshHostClient: () => mocks.refresh }))
vi.mock('./transport/endpoint-auth-headers-store', () => ({
  readEndpointAuthHeaders: async () => null,
  writeEndpointAuthHeaders: async () => {},
  deleteEndpointAuthHeaders: async () => {}
}))
vi.mock('./components/ConnectionLog', () => ({ ConnectionLog: () => null }))
vi.mock('./onboarding/mobile-onboarding-plan', () => ({
  loadMobileOnboardingSteps: async () => [],
  mobileOnboardingDestination: (_steps: unknown, hostId: string) => ({
    pathname: '/',
    params: { hostId }
  })
}))
let renderer: ReactTestRenderer | null = null
const code = (endpoint = 'wss://orca.example') =>
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
    renderer = create(createElement(PairConfirmScreen), { createNodeMock: () => ({}) })
  })
  if (!renderer) {
    throw new Error('No screen')
  }
  return renderer
}
async function press(label: string) {
  if (!renderer) {
    throw new Error('No screen')
  }
  const button = renderer.root
    .findAllByProps({ accessibilityLabel: label })
    .find((node) => String(node.type) === 'Pressable')
  if (!button) {
    throw new Error('Missing button ' + label)
  }
  await act(async () => {
    await button.props.onPress()
  })
}
function field(label: string) {
  if (!renderer) {
    throw new Error('No screen')
  }
  const found = renderer.root.findAll(
    (node) => String(node.type) === 'TextInput' && node.props.accessibilityLabel === label
  )[0]
  if (!found) {
    throw new Error('Missing field ' + label)
  }
  return found
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.platform.OS = 'ios'
  mocks.code = code()
  mocks.start.mockReturnValue({
    result: Promise.resolve({ hostId: 'host-1', credentialsSaved: true }),
    retryCredentialSave: vi.fn(async () => {}),
    dispose: vi.fn(),
    timedOut: false
  })
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

it('shows masked native WSS inputs and keeps credentials out of navigation', async () => {
  await render()
  act(() => {
    field('Header 1 name').props.onChangeText('CF-Access-Client-Secret')
  })
  act(() => {
    field('Header 1 value').props.onChangeText('synthetic-secret')
  })
  expect(field('Header 1 value').props.secureTextEntry).toBe(true)
  await press('Pair')
  expect(mocks.start).toHaveBeenCalledWith(
    expect.objectContaining({ headers: { 'CF-Access-Client-Secret': 'synthetic-secret' } })
  )
  expect(mocks.refresh).toHaveBeenCalledWith('host-1')
  expect(mocks.replace).toHaveBeenCalled()
  expect(JSON.stringify(mocks.replace.mock.calls)).not.toContain('synthetic-secret')
})
it.each(['web', 'plain'])('hides service header inputs for %s', async (kind) => {
  if (kind === 'web') {
    mocks.platform.OS = 'web'
  } else {
    mocks.code = code('ws://192.168.1.5:6768')
  }
  const screen = await render()
  expect(screen.root.findAll((node) => String(node.type) === 'TextInput')).toHaveLength(0)
})
it('validates headers before connecting', async () => {
  await render()
  act(() => {
    field('Header 1 name').props.onChangeText('bad name')
  })
  act(() => {
    field('Header 1 value').props.onChangeText('secret')
  })
  await press('Pair')
  expect(mocks.start).not.toHaveBeenCalled()
})
it('retries only secure storage after a verified pairing', async () => {
  const retry = vi.fn(async () => {
    expect(isCurrent()).toBe(true)
  })
  let isCurrent = () => false
  mocks.start.mockImplementation((args) => {
    isCurrent = args.isCurrent
    return {
      result: Promise.resolve({ hostId: 'host-1', credentialsSaved: false }),
      retryCredentialSave: retry,
      dispose: vi.fn(),
      timedOut: false
    }
  })
  const screen = await render()
  await press('Pair')
  expect(mocks.replace).not.toHaveBeenCalled()
  expect(screen.root.findAll((node) => String(node.type) === 'TextInput')).toHaveLength(0)
  await press('Retry saving credentials')
  expect(retry).toHaveBeenCalledTimes(1)
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(mocks.replace).toHaveBeenCalled()
})
it('disposes synchronously on Back and ignores a late result', async () => {
  let finish: (value: { hostId: string; credentialsSaved: boolean }) => void = () => {}
  const dispose = vi.fn()
  mocks.start.mockReturnValue({
    result: new Promise((resolve) => {
      finish = resolve
    }),
    retryCredentialSave: vi.fn(),
    dispose,
    timedOut: false
  })
  await render()
  let pending: Promise<void> | undefined
  act(() => {
    const button = renderer?.root
      .findAllByProps({ accessibilityLabel: 'Pair' })
      .find((node) => String(node.type) === 'Pressable')
    pending = button?.props.onPress()
  })
  await press('Back')
  expect(dispose).toHaveBeenCalled()
  await act(async () => {
    finish({ hostId: 'host-1', credentialsSaved: true })
    await pending
  })
  expect(mocks.refresh).not.toHaveBeenCalled()
  expect(mocks.replace).toHaveBeenCalledTimes(1)
})
it('drops drafts and cancels the old attempt when a new route arrives', async () => {
  await render()
  act(() => field('Header 1 value').props.onChangeText('old-secret'))
  mocks.code = code('wss://other.example')
  await act(async () => renderer?.update(createElement(PairConfirmScreen)))
  expect(field('Header 1 value').props.value).toBe('')
})

it('allows pairing retry with static errors after verification fails', async () => {
  mocks.start.mockImplementationOnce(() => ({
    result: Promise.reject(new Error('native synthetic-secret failure')),
    retryCredentialSave: vi.fn(),
    dispose: vi.fn(),
    timedOut: false
  }))
  const screen = await render()
  await press('Pair')
  expect(JSON.stringify(screen.toJSON())).not.toContain('synthetic-secret')
  expect(mocks.replace).not.toHaveBeenCalled()
  await press('Pair')
  expect(mocks.start).toHaveBeenCalledTimes(2)
  expect(mocks.replace).toHaveBeenCalledTimes(1)
})
it('blocks duplicate submits and cancels an in-flight attempt on route replacement', async () => {
  let finish: (value: { hostId: string; credentialsSaved: boolean }) => void = () => {}
  const dispose = vi.fn()
  mocks.start.mockReturnValue({
    result: new Promise((resolve) => {
      finish = resolve
    }),
    retryCredentialSave: vi.fn(),
    dispose,
    timedOut: false
  })
  const screen = await render()
  const submit = screen.root
    .findAllByProps({ accessibilityLabel: 'Pair' })
    .find((node) => String(node.type) === 'Pressable')
  let pending: Promise<void> | undefined
  act(() => {
    pending = submit?.props.onPress()
    void submit?.props.onPress()
  })
  expect(mocks.start).toHaveBeenCalledTimes(1)
  mocks.code = code('wss://new.example')
  await act(async () => screen.update(createElement(PairConfirmScreen)))
  expect(dispose).toHaveBeenCalled()
  await act(async () => {
    finish({ hostId: 'old-host', credentialsSaved: true })
    await pending
  })
  expect(mocks.refresh).not.toHaveBeenCalled()
  expect(mocks.replace).not.toHaveBeenCalled()
})
