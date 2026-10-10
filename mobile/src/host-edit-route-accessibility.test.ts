import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EditHostScreen from '../app/h/[hostId]/edit'

const dependencies = vi.hoisted(() => ({
  back: vi.fn(),
  refreshHostClient: vi.fn(),
  loadHosts: vi.fn(),
  primeHosts: vi.fn(),
  updateHostNameAndEndpoint: vi.fn()
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Keyboard: { addListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ hostId: 'host-1' }),
  useRouter: () => ({ back: dependencies.back })
}))

vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft'
}))

vi.mock('./transport/host-store', () => ({
  loadHosts: dependencies.loadHosts,
  updateHostNameAndEndpoint: dependencies.updateHostNameAndEndpoint
}))
vi.mock('./transport/endpoint-auth-headers-store', () => ({
  readEndpointAuthHeaders: async () => null,
  writeEndpointAuthHeaders: async () => {},
  deleteEndpointAuthHeaders: async () => {}
}))

vi.mock('./transport/client-context', () => ({
  usePrimeHosts: () => dependencies.primeHosts,
  useRefreshHostClient: () => dependencies.refreshHostClient
}))

async function renderEditHostRoute(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(EditHostScreen))
    await Promise.resolve()
  })
  if (!renderer) {
    throw new Error('Edit host route did not render')
  }
  return renderer
}

describe('edit host route accessibility', () => {
  beforeEach(() => {
    dependencies.loadHosts.mockReset().mockResolvedValue([
      {
        id: 'host-1',
        name: 'Desk',
        endpoint: 'ws://192.168.1.10:6768',
        deviceToken: 'token',
        publicKeyB64: 'public-key',
        lastConnected: 1
      }
    ])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes stable accessible names for both editable fields', async () => {
    const renderer = await renderEditHostRoute()

    const labels = renderer.root
      .findAllByType('TextInput')
      .map((input) => input.props.accessibilityLabel)
    expect(labels).toEqual(expect.arrayContaining(['Name', 'Address']))

    act(() => renderer.unmount())
  })

  it('exposes edge-auth header controls separately from the address fields', async () => {
    const renderer = await renderEditHostRoute()

    const byLabel = (label: string) =>
      renderer.root
        .findAllByType('TextInput')
        .filter((input) => input.props.accessibilityLabel === label)
    expect(byLabel('Header 1 name')).toHaveLength(1)
    expect(byLabel('Header 1 value')).toHaveLength(1)

    const addButton = renderer.root.findAllByProps({ accessibilityLabel: 'Add header' }).at(0)
    expect(addButton).toBeDefined()
    await act(async () => {
      addButton?.props.onPress()
      await Promise.resolve()
    })
    expect(byLabel('Header 2 name')).toHaveLength(1)
    expect(byLabel('Header 2 value')).toHaveLength(1)

    act(() => renderer.unmount())
  })
})
