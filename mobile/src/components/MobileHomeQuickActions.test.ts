import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '../transport/types'
import { MobileHomeQuickActions } from './MobileHomeQuickActions'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Plus: 'Plus',
  QrCode: 'QrCode'
}))

vi.mock('./PickerModal', async () => {
  const React = await import('react')
  return {
    PickerModal: (props: unknown) => React.createElement('PickerModal', props)
  }
})

function host(id: string, name: string, endpoint: string): HostProfile {
  return {
    id,
    name,
    endpoint,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 1
  }
}

describe('MobileHomeQuickActions', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  async function renderQuickActions(connectedHosts: HostProfile[]) {
    const onPairDesktop = vi.fn()
    const onCreateWorkspace = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    await act(async () => {
      renderer = create(
        createElement(MobileHomeQuickActions, { connectedHosts, onPairDesktop, onCreateWorkspace })
      )
    })
    consoleError.mockRestore()
    return { onCreateWorkspace }
  }

  function newWorkspaceButton() {
    return renderer!.root.findAllByType('Pressable')[1]
  }

  function picker() {
    return renderer!.root.findByType('PickerModal')
  }

  it('disables workspace creation without a connected host', async () => {
    await renderQuickActions([])

    expect(newWorkspaceButton().props.disabled).toBe(true)
    expect(newWorkspaceButton().props.accessibilityState).toEqual({ disabled: true })
    expect(picker().props.visible).toBe(false)
  })

  it('opens the only connected host directly', async () => {
    const desk = host('desk', 'Desk', 'ws://192.168.1.2:6768')
    const callbacks = await renderQuickActions([desk])

    act(() => newWorkspaceButton().props.onPress())

    expect(callbacks.onCreateWorkspace).toHaveBeenCalledWith('desk')
    expect(picker().props.visible).toBe(false)
  })

  it('asks which host to use when multiple are connected', async () => {
    const callbacks = await renderQuickActions([
      host('desk', 'Desk', 'ws://192.168.1.2:6768'),
      host('laptop', 'Laptop', 'wss://relay.example.com/mobile')
    ])

    act(() => newWorkspaceButton().props.onPress())

    expect(callbacks.onCreateWorkspace).not.toHaveBeenCalled()
    expect(picker().props.visible).toBe(true)
    expect(picker().props.title).toBe('Create Workspace On')
    expect(picker().props.options).toEqual([
      { value: 'desk', label: 'Desk', subtitle: '192.168.1.2:6768' },
      { value: 'laptop', label: 'Laptop', subtitle: 'relay.example.com' }
    ])

    act(() => picker().props.onSelect('laptop'))
    expect(callbacks.onCreateWorkspace).not.toHaveBeenCalled()
    expect(picker().props.visible).toBe(false)

    act(() => picker().props.onAfterClose())
    expect(callbacks.onCreateWorkspace).toHaveBeenCalledWith('laptop')
  })
})
