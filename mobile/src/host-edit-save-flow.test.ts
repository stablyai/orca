import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EditHostScreen from '../app/h/[hostId]/edit'

const dependencies = vi.hoisted(() => ({
  alert: vi.fn(),
  back: vi.fn(),
  forceReconnectHost: vi.fn(),
  forceReconnectHostAfterEdit: vi.fn(),
  getHostListLoadRevision: vi.fn(() => 0),
  loadHosts: vi.fn(),
  primeHosts: vi.fn(),
  updateHostNameAndEndpoint: vi.fn(),
  hostId: 'host-1' as string | undefined
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: dependencies.alert },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
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

vi.mock('./transport/host-list-load-sharing', () => ({
  getHostListLoadRevision: dependencies.getHostListLoadRevision
}))

vi.mock('./transport/client-context', () => ({
  useForceReconnect: () => dependencies.forceReconnectHost,
  useForceReconnectAfterEdit: () => dependencies.forceReconnectHostAfterEdit,
  usePrimeHosts: () => dependencies.primeHosts
}))

const HOST_FIXTURE = {
  id: 'host-1',
  name: 'Desk',
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'token',
  publicKeyB64: 'public-key',
  lastConnected: 1
}

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

async function renderEditHostRoute(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    await act(async () => {
      renderer = create(createElement(EditHostScreen))
      await Promise.resolve()
    })
  } finally {
    restoreConsoleError()
  }
  if (!renderer) {
    throw new Error('Edit host route did not render')
  }
  return renderer
}

function setFieldValue(
  renderer: ReactTestRenderer,
  accessibilityLabel: 'Name' | 'Address',
  value: string
): void {
  const input = renderer.root
    .findAllByType('TextInput')
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
    .findAllByType('Pressable')
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
  return renderer.root.findAllByType('Text').some((node) => {
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
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    dependencies.hostId = 'host-1'
    dependencies.alert.mockReset()
    dependencies.back.mockReset()
    dependencies.forceReconnectHost.mockReset().mockResolvedValue(undefined)
    dependencies.forceReconnectHostAfterEdit.mockReset().mockResolvedValue(undefined)
    dependencies.getHostListLoadRevision.mockReset().mockReturnValue(0)
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
      name: 'Home Desk'
    })
    expect(dependencies.forceReconnectHost).not.toHaveBeenCalled()
    expect(dependencies.back).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('endpoint-only save updates only the endpoint and reconnects', async () => {
    const savedHost = { ...HOST_FIXTURE, endpoint: 'ws://192.168.1.20:6768' }
    dependencies.loadHosts.mockResolvedValueOnce([HOST_FIXTURE]).mockResolvedValueOnce([savedHost])
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', '192.168.1.20:6768')
    await pressSave(renderer)

    expect(dependencies.updateHostNameAndEndpoint).toHaveBeenCalledWith('host-1', {
      endpoint: 'ws://192.168.1.20:6768'
    })
    expect(dependencies.primeHosts).toHaveBeenCalledWith([savedHost], 0)
    expect(dependencies.forceReconnectHost).toHaveBeenCalledWith('host-1', savedHost)
    expect(dependencies.back).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('saves name and endpoint together in one call, then reconnects', async () => {
    const savedHost = {
      ...HOST_FIXTURE,
      name: 'Home Desk',
      endpoint: 'ws://192.168.1.20:6768'
    }
    dependencies.loadHosts.mockResolvedValueOnce([HOST_FIXTURE]).mockResolvedValueOnce([savedHost])
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Name', 'Home Desk')
    setFieldValue(renderer, 'Address', '192.168.1.20:6768')
    await pressSave(renderer)

    expect(dependencies.updateHostNameAndEndpoint).toHaveBeenCalledTimes(1)
    expect(dependencies.updateHostNameAndEndpoint).toHaveBeenCalledWith('host-1', {
      name: 'Home Desk',
      endpoint: 'ws://192.168.1.20:6768'
    })
    expect(dependencies.primeHosts).toHaveBeenCalledWith([savedHost], 0)
    expect(dependencies.forceReconnectHost).toHaveBeenCalledWith('host-1', savedHost)
    expect(dependencies.back).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('navigates back without saving or reconnecting when nothing changed', async () => {
    const renderer = await renderEditHostRoute()
    await pressSave(renderer)

    expect(dependencies.updateHostNameAndEndpoint).not.toHaveBeenCalled()
    expect(dependencies.forceReconnectHost).not.toHaveBeenCalled()
    expect(dependencies.back).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('shows the error and does not navigate back or reconnect when the save rejects', async () => {
    dependencies.updateHostNameAndEndpoint.mockRejectedValueOnce(new Error('Host not found'))
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Name', 'Home Desk')
    await pressSave(renderer)

    expect(findText(renderer, 'Host not found')).toBe(true)
    expect(dependencies.forceReconnectHost).not.toHaveBeenCalled()
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

  it('retires the old endpoint client when post-save profile loading fails', async () => {
    dependencies.loadHosts
      .mockResolvedValueOnce([HOST_FIXTURE])
      .mockRejectedValueOnce(new Error('keychain locked'))
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', '192.168.1.20:6768')
    await pressSave(renderer)

    expect(dependencies.primeHosts).not.toHaveBeenCalled()
    expect(dependencies.forceReconnectHost).not.toHaveBeenCalled()
    expect(dependencies.forceReconnectHostAfterEdit).toHaveBeenCalledWith('host-1', HOST_FIXTURE, {
      endpoint: 'ws://192.168.1.20:6768'
    })
    expect(dependencies.back).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('merges the endpoint edit into the current cache when the host reload omits it', async () => {
    dependencies.loadHosts.mockResolvedValueOnce([HOST_FIXTURE]).mockResolvedValueOnce([])
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', '192.168.1.20:6768')
    await pressSave(renderer)

    expect(dependencies.forceReconnectHost).not.toHaveBeenCalled()
    expect(dependencies.forceReconnectHostAfterEdit).toHaveBeenCalledWith('host-1', HOST_FIXTURE, {
      endpoint: 'ws://192.168.1.20:6768'
    })
    expect(dependencies.back).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('still navigates back and alerts when the post-save reconnect rejects', async () => {
    const savedHost = { ...HOST_FIXTURE, endpoint: 'ws://192.168.1.20:6768' }
    dependencies.loadHosts.mockResolvedValueOnce([HOST_FIXTURE]).mockResolvedValueOnce([savedHost])
    dependencies.forceReconnectHost.mockRejectedValueOnce(new Error('connect failed'))
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', '192.168.1.20:6768')
    await pressSave(renderer)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(dependencies.forceReconnectHost).toHaveBeenCalledWith('host-1', savedHost)
    expect(dependencies.back).toHaveBeenCalledTimes(1)
    expect(dependencies.alert).toHaveBeenCalledWith(
      "Couldn't reconnect to desktop",
      'Make sure desktop Orca is open and both devices are online, then try again.',
      [{ text: 'Dismiss', style: 'cancel' }]
    )

    act(() => renderer.unmount())
  })

  it('reconnects with the fresh persisted profile when relay routing changed mid-edit', async () => {
    const relayHost = {
      ...HOST_FIXTURE,
      endpoint: 'ws://192.168.1.20:6768',
      endpoints: [
        {
          id: 'direct-primary',
          kind: 'lan' as const,
          url: 'ws://192.168.1.20:6768'
        },
        {
          id: 'relay-primary',
          kind: 'relay' as const,
          url: 'wss://relay.invalid/host-1'
        }
      ]
    }
    dependencies.loadHosts.mockResolvedValueOnce([HOST_FIXTURE]).mockResolvedValueOnce([relayHost])
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', '192.168.1.20:6768')
    await pressSave(renderer)

    expect(dependencies.primeHosts).toHaveBeenCalledWith([relayHost], 0)
    expect(dependencies.forceReconnectHost).toHaveBeenCalledWith('host-1', relayHost)

    act(() => renderer.unmount())
  })

  it('reloads the current edited profile when an unrelated write invalidates a snapshot', async () => {
    const editedHost = { ...HOST_FIXTURE, endpoint: 'ws://192.168.1.20:6768' }
    const invalidatedHost = { ...HOST_FIXTURE, name: 'Stale snapshot' }
    dependencies.loadHosts
      .mockResolvedValueOnce([HOST_FIXTURE])
      .mockResolvedValueOnce([invalidatedHost])
      .mockResolvedValueOnce([editedHost])
    dependencies.getHostListLoadRevision
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValue(2)
    const renderer = await renderEditHostRoute()
    setFieldValue(renderer, 'Address', '192.168.1.20:6768')
    await pressSave(renderer)

    expect(dependencies.primeHosts).toHaveBeenCalledWith([editedHost], 2)
    expect(dependencies.forceReconnectHost).toHaveBeenCalledWith('host-1', editedHost)

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
})

describe('edit host load() error states', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    dependencies.hostId = 'host-1'
    dependencies.alert.mockReset()
    dependencies.back.mockReset()
    dependencies.forceReconnectHost.mockReset().mockResolvedValue(undefined)
    dependencies.forceReconnectHostAfterEdit.mockReset().mockResolvedValue(undefined)
    dependencies.getHostListLoadRevision.mockReset().mockReturnValue(0)
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
    expect(renderer.root.findAllByType('TextInput')).toHaveLength(0)

    act(() => renderer.unmount())
  })

  it('shows a not-saved message when the host is not in the loaded list', async () => {
    dependencies.loadHosts.mockReset().mockResolvedValue([])
    const renderer = await renderEditHostRoute()

    expect(findText(renderer, 'This host was removed from this phone.')).toBe(true)
    expect(renderer.root.findAllByType('TextInput')).toHaveLength(0)

    act(() => renderer.unmount())
  })

  it('surfaces the error message when loadHosts rejects', async () => {
    dependencies.loadHosts.mockReset().mockRejectedValue(new Error('storage unreadable'))
    const renderer = await renderEditHostRoute()

    expect(findText(renderer, 'storage unreadable')).toBe(true)
    expect(renderer.root.findAllByType('TextInput')).toHaveLength(0)

    act(() => renderer.unmount())
  })
})
