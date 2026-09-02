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
    const quickActions = (hosts: HostProfile[]) =>
      createElement(MobileHomeQuickActions, {
        connectedHosts: hosts,
        onPairDesktop,
        onCreateWorkspace
      })
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    await act(async () => {
      renderer = create(quickActions(connectedHosts))
    })
    consoleError.mockRestore()
    return {
      onCreateWorkspace,
      rerender: async (hosts: HostProfile[]) => {
        await act(async () => renderer!.update(quickActions(hosts)))
      }
    }
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

  it('disambiguates path-routed hosts without exposing endpoint paths', async () => {
    await renderQuickActions([
      host('desk-a', 'Desk', 'wss://gateway.example.com/v1/connect/bearer-secret-a'),
      host('desk-b', 'Desk', 'wss://gateway.example.com/v1/connect/bearer-secret-b')
    ])

    act(() => newWorkspaceButton().props.onPress())

    expect(picker().props.options).toEqual([
      {
        value: 'desk-a',
        label: 'Desk',
        subtitle: 'gateway.example.com · desk-a'
      },
      {
        value: 'desk-b',
        label: 'Desk',
        subtitle: 'gateway.example.com · desk-b'
      }
    ])
    expect(JSON.stringify(picker().props.options)).not.toContain('bearer-secret')
  })

  it('does not expose malformed legacy endpoint details', async () => {
    await renderQuickActions([
      host('desk-a', 'Desk', 'gateway.example.com/v1/connect/bearer-secret?token=query-secret'),
      host('desk-b', 'Desk', 'localhost:6768/private-secret')
    ])

    act(() => newWorkspaceButton().props.onPress())

    expect(picker().props.options).toEqual([
      { value: 'desk-a', label: 'Desk', subtitle: 'Unknown endpoint · desk-a' },
      { value: 'desk-b', label: 'Desk', subtitle: 'Unknown endpoint · desk-b' }
    ])
    expect(JSON.stringify(picker().props.options)).not.toContain('secret')
  })

  it('closes a stale picker when fewer than two hosts remain connected', async () => {
    const desk = host('desk', 'Desk', 'ws://192.168.1.2:6768')
    const laptop = host('laptop', 'Laptop', 'wss://relay.example.com/mobile')
    const callbacks = await renderQuickActions([desk, laptop])

    act(() => newWorkspaceButton().props.onPress())
    expect(picker().props.visible).toBe(true)

    await callbacks.rerender([desk])
    expect(picker().props.visible).toBe(false)
    act(() => picker().props.onAfterClose())

    await callbacks.rerender([desk, laptop])
    expect(picker().props.visible).toBe(false)
  })

  it('does not reopen a stale picker if its old host set returns while closing', async () => {
    const desk = host('desk', 'Desk', 'ws://192.168.1.2:6768')
    const laptop = host('laptop', 'Laptop', 'wss://relay.example.com/mobile')
    const callbacks = await renderQuickActions([desk, laptop])

    act(() => newWorkspaceButton().props.onPress())
    await callbacks.rerender([desk])
    await callbacks.rerender([desk, laptop])

    expect(picker().props.visible).toBe(false)
    act(() => picker().props.onAfterClose())
    expect(callbacks.onCreateWorkspace).not.toHaveBeenCalled()
  })

  it('keeps a selected host through an unrelated topology change while closing', async () => {
    const desk = host('desk', 'Desk', 'ws://192.168.1.2:6768')
    const laptop = host('laptop', 'Laptop', 'wss://relay.example.com/mobile')
    const callbacks = await renderQuickActions([desk, laptop])

    act(() => newWorkspaceButton().props.onPress())
    act(() => picker().props.onSelect('laptop'))
    await callbacks.rerender([
      desk,
      laptop,
      host('server', 'Server', 'wss://ssh.example.com/mobile')
    ])
    act(() => picker().props.onAfterClose())

    expect(callbacks.onCreateWorkspace).toHaveBeenCalledWith('laptop')
  })

  it('drops a selection that disconnects while the picker is closing', async () => {
    const desk = host('desk', 'Desk', 'ws://192.168.1.2:6768')
    const laptop = host('laptop', 'Laptop', 'wss://relay.example.com/mobile')
    const callbacks = await renderQuickActions([desk, laptop])

    act(() => newWorkspaceButton().props.onPress())
    act(() => picker().props.onSelect('laptop'))
    await callbacks.rerender([desk])
    act(() => picker().props.onAfterClose())

    expect(callbacks.onCreateWorkspace).not.toHaveBeenCalled()
  })
})
