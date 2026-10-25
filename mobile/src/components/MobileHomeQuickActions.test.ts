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
  }

  function newWorkspaceButton() {
    return renderer!.root.findAllByType('Pressable')[1]
  }

  it('disables workspace creation without a connected host', async () => {
    await renderQuickActions([])

    expect(newWorkspaceButton().props.disabled).toBe(true)
    expect(newWorkspaceButton().props.accessibilityState).toEqual({ disabled: true })
  })
})
