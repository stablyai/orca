import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EditHostScreen from '../app/h/[hostId]/edit'

const dependencies = vi.hoisted(() => ({
  back: vi.fn(),
  refreshHostClient: vi.fn(),
  loadHosts: vi.fn(),
  primeHosts: vi.fn(),
  updateHostNameAndEndpoint: vi.fn(),
  readEndpointAuthHeaders: vi.fn(),
  writeEndpointAuthHeaders: vi.fn(),
  deleteEndpointAuthHeaders: vi.fn(),
  hostId: 'host-1' as string | undefined
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('./platform/keyboard-occlusion', () => ({ subscribeSoftKeyboard: () => () => {} }))
vi.mock('./transport/endpoint-auth-headers-store', () => ({
  readEndpointAuthHeaders: dependencies.readEndpointAuthHeaders,
  writeEndpointAuthHeaders: dependencies.writeEndpointAuthHeaders,
  deleteEndpointAuthHeaders: dependencies.deleteEndpointAuthHeaders
}))

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ hostId: dependencies.hostId }),
  useRouter: () => ({ back: dependencies.back })
}))

vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft'
}))

vi.mock('./transport/host-store', () => ({
  loadHosts: dependencies.loadHosts,
  updateHostNameAndEndpoint: dependencies.updateHostNameAndEndpoint
}))

vi.mock('./transport/host-client-hooks', () => ({
  usePrimeHosts: () => dependencies.primeHosts,
  useRefreshHostClient: () => dependencies.refreshHostClient
}))

const HOST_FIXTURE = {
  id: 'host-1',
  name: 'Desk',
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'token',
  publicKeyB64: 'public-key',
  lastConnected: 1
}

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

function setFieldValue(
  renderer: ReactTestRenderer,
  accessibilityLabel: 'Name' | 'Address' | 'Header 1 name' | 'Header 1 value',
  value: string
): void {
  const input = renderer.root
    .findAll((node) => String(node.type) === 'TextInput')
    .find((node) => node.props.accessibilityLabel === accessibilityLabel)
  if (!input) {
    throw new Error(`${accessibilityLabel} input not found`)
  }
  act(() => {
    input.props.onChangeText(value)
  })
}

function findSaveButton(renderer: ReactTestRenderer) {
  const button = renderer.root
    .findAll((node) => String(node.type) === 'Pressable')
    .find((node) => node.props.accessibilityLabel === 'Save host')
  if (!button) {
    throw new Error('Save button not found')
  }
  return button
}

async function pressSave(renderer: ReactTestRenderer): Promise<void> {
  const button = findSaveButton(renderer)
  await act(async () => {
    button.props.onPress()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function findText(renderer: ReactTestRenderer, match: string): boolean {
  return renderer.root
    .findAll((node) => String(node.type) === 'Text')
    .some((node) => {
      const children = node.props.children
      if (typeof children === 'string') {
        return children.includes(match)
      }
      if (Array.isArray(children)) {
        return children.join('').includes(match)
      }
      return false
    })
}

describe('edit host handleSave', () => {
  beforeEach(() => {
    dependencies.readEndpointAuthHeaders.mockReset().mockResolvedValue(null)
    dependencies.writeEndpointAuthHeaders.mockReset().mockResolvedValue(undefined)
    dependencies.deleteEndpointAuthHeaders.mockReset().mockResolvedValue(undefined)
    dependencies.hostId = 'host-1'
    dependencies.back.mockReset()
    dependencies.refreshHostClient.mockReset()
    dependencies.loadHosts.mockReset().mockResolvedValue([HOST_FIXTURE])
    dependencies.primeHosts.mockReset()
    dependencies.updateHostNameAndEndpoint.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rename-only save updates only the name and does not reconnect', async () => {
    const storedEndpoint = 'wss://Desk.Example.com/%6Fruntime?route=%72ed'
    dependencies.loadHosts.mockResolvedValueOnce([{ ...HOST_FIXTURE, endpoint: storedEndpoint }])
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', '  wss://%64esk.example.com:443  ')
    setFieldValue(renderer, 'Name', 'Home Desk')

    expect(findText(renderer, `Connects to ${storedEndpoint}`)).toBe(true)
    await pressSave(renderer)

    expect(dependencies.updateHostNameAndEndpoint).toHaveBeenCalledWith('host-1', {
      personalName: 'Home Desk'
    })
    expect(dependencies.refreshHostClient).not.toHaveBeenCalled()
    expect(dependencies.back).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('endpoint-only save updates only the endpoint and reconnects', async () => {
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', '192.168.1.20:6768')
    await pressSave(renderer)

    expect(dependencies.updateHostNameAndEndpoint).toHaveBeenCalledWith('host-1', {
      endpoint: 'ws://192.168.1.20:6768'
    })
    expect(dependencies.refreshHostClient).toHaveBeenCalledWith('host-1')
    expect(dependencies.back).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('previews and saves the secure default port when switching a LAN host to WSS', async () => {
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', 'wss://tunnel.example.com')

    expect(findText(renderer, 'Connects to wss://tunnel.example.com:443')).toBe(true)
    await pressSave(renderer)

    expect(dependencies.updateHostNameAndEndpoint).toHaveBeenCalledWith('host-1', {
      endpoint: 'wss://tunnel.example.com:443'
    })
    expect(dependencies.refreshHostClient).toHaveBeenCalledWith('host-1')
    expect(dependencies.back).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  it('stores headers securely and reconnects an already paired secure host', async () => {
    dependencies.loadHosts.mockResolvedValue([
      { ...HOST_FIXTURE, endpoint: 'wss://orca.example.com' }
    ])
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Header 1 name', 'CF-Access-Client-Id')
    setFieldValue(renderer, 'Header 1 value', 'secret-value')
    await pressSave(renderer)

    expect(dependencies.writeEndpointAuthHeaders).toHaveBeenCalledWith(
      'host-1',
      {
        'CF-Access-Client-Id': 'secret-value'
      },
      'wss://orca.example.com'
    )
    expect(dependencies.refreshHostClient).toHaveBeenCalledWith('host-1')
    act(() => renderer.unmount())
  })

  it('blocks edge credentials on a plain WebSocket address', async () => {
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Header 1 name', 'CF-Access-Client-Id')
    setFieldValue(renderer, 'Header 1 value', 'secret-value')

    expect(findSaveButton(renderer).props.disabled).toBe(true)
    await pressSave(renderer)
    expect(dependencies.writeEndpointAuthHeaders).not.toHaveBeenCalled()
    expect(dependencies.updateHostNameAndEndpoint).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('does not rewrite stored edge credentials on a name-only save', async () => {
    dependencies.loadHosts.mockResolvedValue([
      { ...HOST_FIXTURE, endpoint: 'wss://orca.example.com' }
    ])
    dependencies.readEndpointAuthHeaders.mockResolvedValue({
      'CF-Access-Client-Id': 'secret-value'
    })
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Name', 'Renamed host')
    await pressSave(renderer)

    expect(dependencies.writeEndpointAuthHeaders).not.toHaveBeenCalled()
    expect(dependencies.deleteEndpointAuthHeaders).not.toHaveBeenCalled()
    expect(dependencies.refreshHostClient).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it.each(['ws://192.168.1.20:6768', 'wss://other.example.com:443', 'wss://orca.example.com:8443'])(
    'preserves unchanged credentials when switching the endpoint to %s',
    async (endpoint) => {
      dependencies.loadHosts.mockResolvedValue([
        { ...HOST_FIXTURE, endpoint: 'wss://orca.example.com' }
      ])
      dependencies.readEndpointAuthHeaders.mockResolvedValue({
        'CF-Access-Client-Id': 'secret-value'
      })
      const renderer = await renderEditHostRoute()
      setFieldValue(renderer, 'Address', endpoint)

      expect(findSaveButton(renderer).props.disabled).toBe(false)
      await pressSave(renderer)

      expect(dependencies.updateHostNameAndEndpoint).toHaveBeenCalledWith('host-1', { endpoint })
      expect(dependencies.writeEndpointAuthHeaders).not.toHaveBeenCalled()
      expect(dependencies.deleteEndpointAuthHeaders).not.toHaveBeenCalled()
      expect(dependencies.refreshHostClient).toHaveBeenCalledWith('host-1')
      expect(dependencies.back).toHaveBeenCalledTimes(1)
      act(() => renderer.unmount())
    }
  )

  it('re-primes the committed endpoint after an edge-auth save failure without exposing secrets', async () => {
    const updated = { ...HOST_FIXTURE, endpoint: 'wss://orca.example.com:443' }
    dependencies.loadHosts.mockResolvedValueOnce([HOST_FIXTURE]).mockResolvedValue([updated])
    dependencies.writeEndpointAuthHeaders.mockRejectedValue(new Error('keychain secret-value'))
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', 'wss://orca.example.com')
    setFieldValue(renderer, 'Header 1 name', 'CF-Access-Client-Id')
    setFieldValue(renderer, 'Header 1 value', 'secret-value')
    await pressSave(renderer)

    expect(findText(renderer, 'Could not save edge authentication.')).toBe(true)
    expect(findText(renderer, 'keychain secret-value')).toBe(false)
    expect(dependencies.primeHosts).toHaveBeenCalledWith([updated])
    expect(dependencies.refreshHostClient).toHaveBeenCalledWith('host-1')
    expect(dependencies.back).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('can restore the original address after metadata commits but authentication fails', async () => {
    let stored = { ...HOST_FIXTURE, endpoint: 'wss://a.example.com' }
    dependencies.loadHosts.mockImplementation(async () => [stored])
    dependencies.updateHostNameAndEndpoint.mockImplementation(async (_id, changes) => {
      stored = { ...stored, ...changes }
    })
    dependencies.writeEndpointAuthHeaders.mockRejectedValueOnce(new Error('locked'))
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', 'wss://b.example.com')
    setFieldValue(renderer, 'Header 1 name', 'X-Token')
    setFieldValue(renderer, 'Header 1 value', 'secret')
    await pressSave(renderer)
    expect(stored.endpoint).toBe('wss://b.example.com:443')
    setFieldValue(renderer, 'Address', 'wss://a.example.com')
    await pressSave(renderer)
    expect(stored.endpoint).toBe('wss://a.example.com:443')
    expect(dependencies.back).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  it('saves name and endpoint together in one call, then reconnects', async () => {
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Name', 'Home Desk')
    setFieldValue(renderer, 'Address', '192.168.1.20:6768')
    await pressSave(renderer)

    expect(dependencies.updateHostNameAndEndpoint).toHaveBeenCalledTimes(1)
    expect(dependencies.updateHostNameAndEndpoint).toHaveBeenCalledWith('host-1', {
      personalName: 'Home Desk',
      endpoint: 'ws://192.168.1.20:6768'
    })
    expect(dependencies.refreshHostClient).toHaveBeenCalledWith('host-1')
    expect(dependencies.back).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('navigates back without saving or reconnecting when nothing changed', async () => {
    const renderer = await renderEditHostRoute()
    await pressSave(renderer)

    expect(dependencies.updateHostNameAndEndpoint).not.toHaveBeenCalled()
    expect(dependencies.refreshHostClient).not.toHaveBeenCalled()
    expect(dependencies.back).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('shows the error and does not navigate back or reconnect when the save rejects', async () => {
    dependencies.updateHostNameAndEndpoint.mockRejectedValueOnce(new Error('Host not found'))
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Name', 'Home Desk')
    await pressSave(renderer)

    expect(findText(renderer, 'Host not found')).toBe(true)
    expect(dependencies.refreshHostClient).not.toHaveBeenCalled()
    expect(dependencies.back).not.toHaveBeenCalled()

    act(() => renderer.unmount())
  })

  it('still navigates back when the post-save re-prime fails', async () => {
    dependencies.loadHosts
      .mockResolvedValueOnce([HOST_FIXTURE])
      .mockRejectedValueOnce(new Error('boom'))
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Name', 'Home Desk')
    await pressSave(renderer)

    expect(dependencies.primeHosts).not.toHaveBeenCalled()
    expect(dependencies.back).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('ignores a second Save trigger while a save is already in flight', async () => {
    let resolveSave: () => void = () => {}
    dependencies.updateHostNameAndEndpoint.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        })
    )
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Name', 'Home Desk')
    const button = findSaveButton(renderer)

    await act(async () => {
      button.props.onPress()
      button.props.onPress()
      await Promise.resolve()
    })

    expect(dependencies.updateHostNameAndEndpoint).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveSave()
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => renderer.unmount())
  })
  it('does not navigate again if the user leaves while the save is pending', async () => {
    let resolveSave = () => {}
    dependencies.updateHostNameAndEndpoint.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        })
    )
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', '192.168.1.20:6768')
    await pressSave(renderer)
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Back' }).props.onPress()
      renderer.unmount()
    })
    expect(dependencies.back).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveSave()
    })
    expect(dependencies.back).toHaveBeenCalledTimes(1)
    expect(dependencies.refreshHostClient).toHaveBeenCalledWith('host-1')
  })

  it('does not start saving credentials after leaving during the metadata write', async () => {
    let finishSave = () => {}
    dependencies.updateHostNameAndEndpoint.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        })
    )
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', 'wss://orca.example.com')
    setFieldValue(renderer, 'Header 1 name', 'X-Token')
    setFieldValue(renderer, 'Header 1 value', 'synthetic-secret')
    await pressSave(renderer)
    act(() => renderer.root.findByProps({ accessibilityLabel: 'Back' }).props.onPress())
    await act(async () => finishSave())

    expect(dependencies.writeEndpointAuthHeaders).not.toHaveBeenCalled()
    expect(dependencies.refreshHostClient).toHaveBeenCalledWith('host-1')
    expect(dependencies.back).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })
})

describe('edit host load() error states', () => {
  beforeEach(() => {
    dependencies.readEndpointAuthHeaders.mockReset().mockResolvedValue(null)
    dependencies.hostId = 'host-1'
    dependencies.back.mockReset()
    dependencies.refreshHostClient.mockReset()
    dependencies.loadHosts.mockReset().mockResolvedValue([HOST_FIXTURE])
    dependencies.primeHosts.mockReset()
    dependencies.updateHostNameAndEndpoint.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows "Missing host." when hostId is absent', async () => {
    dependencies.hostId = undefined
    const renderer = await renderEditHostRoute()

    expect(findText(renderer, 'Missing host.')).toBe(true)
    expect(renderer.root.findAll((node) => String(node.type) === 'TextInput')).toHaveLength(0)

    act(() => renderer.unmount())
  })

  it('shows a not-saved message when the host is not in the loaded list', async () => {
    dependencies.loadHosts.mockReset().mockResolvedValue([])
    const renderer = await renderEditHostRoute()

    expect(findText(renderer, 'This host was removed from this phone.')).toBe(true)
    expect(renderer.root.findAll((node) => String(node.type) === 'TextInput')).toHaveLength(0)

    act(() => renderer.unmount())
  })

  it('uses safe error copy when loadHosts rejects', async () => {
    dependencies.loadHosts.mockReset().mockRejectedValue(new Error('storage unreadable'))
    const renderer = await renderEditHostRoute()

    expect(findText(renderer, 'Failed to load host or edge authentication.')).toBe(true)
    expect(renderer.root.findAll((node) => String(node.type) === 'TextInput')).toHaveLength(0)

    act(() => renderer.unmount())
  })

  it('keeps the form unavailable until the edge credential baseline is loaded', async () => {
    let resolveRead: (headers: null) => void = () => {}
    dependencies.readEndpointAuthHeaders.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        resolveRead = resolve
      })
    )
    const renderer = await renderEditHostRoute()
    expect(renderer.root.findAll((node) => String(node.type) === 'TextInput')).toHaveLength(0)
    expect(findSaveButton(renderer).props.disabled).toBe(true)
    await act(async () => resolveRead(null))
    expect(
      renderer.root.findAll((node) => String(node.type) === 'TextInput').length
    ).toBeGreaterThan(0)
    act(() => renderer.unmount())
  })

  it('blocks saves after credential loading fails without displaying the keychain error', async () => {
    dependencies.readEndpointAuthHeaders.mockRejectedValueOnce(new Error('secret-keychain-data'))
    const renderer = await renderEditHostRoute()
    expect(findText(renderer, 'Failed to load host or edge authentication.')).toBe(true)
    expect(findText(renderer, 'secret-keychain-data')).toBe(false)
    expect(renderer.root.findAll((node) => String(node.type) === 'TextInput')).toHaveLength(0)
    expect(findSaveButton(renderer).props.disabled).toBe(true)
    act(() => renderer.unmount())
  })

  it('does not replace a new route credential baseline with a stale keychain read', async () => {
    let finishRead: (headers: Record<string, string>) => void = () => {}
    dependencies.readEndpointAuthHeaders
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = resolve
          })
      )
      .mockResolvedValueOnce({ 'X-Token': 'new-host-secret' })
    dependencies.loadHosts
      .mockResolvedValueOnce([{ ...HOST_FIXTURE, endpoint: 'wss://old.example.com' }])
      .mockResolvedValueOnce([{ ...HOST_FIXTURE, id: 'host-2', endpoint: 'wss://new.example.com' }])
    const renderer = await renderEditHostRoute()
    dependencies.hostId = 'host-2'
    await act(async () => renderer.update(createElement(EditHostScreen)))
    await act(async () => finishRead({ 'X-Token': 'old-host-secret' }))

    const field = renderer.root
      .findAll((node) => String(node.type) === 'TextInput')
      .find((node) => node.props.accessibilityLabel === 'Header 1 value')
    expect(field?.props.value).toBe('new-host-secret')
    act(() => renderer.unmount())
  })
})
