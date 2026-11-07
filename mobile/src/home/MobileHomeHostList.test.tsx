import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetIrohHostStatusForTests,
  setIrohHostStatus
} from '../transport/mobile-iroh-host-status'
import type { HostCatalogEntry } from '../transport/types'
import { MobileHomeHostList } from './MobileHomeHostList'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ChevronRight: 'ChevronRight',
  Laptop: 'Laptop',
  Monitor: 'Monitor',
  Plus: 'Plus',
  Server: 'Server'
}))

describe('MobileHomeHostList', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    resetIrohHostStatusForTests()
  })

  it('refreshes the memoized row hint from real status writes without changing any row props', () => {
    const host: HostCatalogEntry = {
      id: 'iroh-status-desktop',
      name: 'My desktop',
      endpoint: 'ws://192.168.1.2:1234',
      publicKeyB64: 'public-key',
      lastConnected: 0,
      credentialStatus: 'ready',
      profile: null
    }
    const onOpen = vi.fn()
    const onOpenActions = vi.fn()
    act(() => {
      renderer = create(
        createElement(MobileHomeHostList, {
          first: true,
          hosts: [host],
          autoConnectHostIds: [host.id],
          hostAttempts: {},
          hostLastConnected: {},
          hostConnections: {},
          hostStates: { [host.id]: 'reconnecting' },
          worktreeInfo: {},
          onOpen,
          onOpenActions,
          onPairDesktop: vi.fn()
        })
      )
    })
    const root = renderer!.root
    const [row] = root.findAll((node) => String(node.type) === 'Pressable')
    expect(row.props.accessibilityLabel).toContain('Reconnecting…')
    expect(row.props.accessibilityLabel).not.toContain('Iroh')

    // Only the real external store changes; the list and all row props remain untouched.
    act(() => setIrohHostStatus(host.id, 'attempting'))
    expect(row.props.accessibilityLabel).toContain('Reconnecting… — Iroh attempting…')
    expect(
      root.findAll((node) => String(node.type) === 'Text').map((node) => node.props.children)
    ).toContain('Reconnecting… — Iroh attempting…')

    act(() => setIrohHostStatus(host.id, 'failed', 'native_module_unavailable'))
    expect(row.props.accessibilityLabel).toContain(
      'Reconnecting… — Iroh failed: native_module_unavailable'
    )
    expect(
      root.findAll((node) => String(node.type) === 'Text').map((node) => node.props.children)
    ).toContain('Reconnecting… — Iroh failed: native_module_unavailable')

    act(() => setIrohHostStatus(host.id, 'idle'))
    expect(row.props.accessibilityLabel).not.toContain('Iroh')
  })
})
