import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionSheetModal } from './components/ActionSheetModal'
import { getHostListActionSheetActions } from './host-list-action-sheet-actions'
import type { ConnectionState, HostProfile } from './transport/types'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('./components/bottom-drawer/BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))

vi.mock('lucide-react-native', () => ({
  Activity: vi.fn(),
  Edit3: vi.fn(),
  PowerOff: vi.fn(),
  RefreshCw: vi.fn(),
  Trash2: vi.fn()
}))

const HOST: HostProfile = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://192.168.21.4:6768',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
}

function build(overrides: { state?: ConnectionState; hasEverConnected?: boolean } = {}) {
  const spies = {
    onDismiss: vi.fn(),
    onReconnect: vi.fn(),
    onDisconnect: vi.fn(),
    onDiagnostics: vi.fn(),
    onEdit: vi.fn(),
    onRemove: vi.fn()
  }
  const actions = getHostListActionSheetActions({
    host: HOST,
    state: overrides.state ?? 'connected',
    hasEverConnected: overrides.hasEverConnected ?? true,
    ...spies
  })
  return { actions, spies }
}

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('getHostListActionSheetActions', () => {
  it.each([
    ['Network diagnostics', 'onDiagnostics'],
    ['Edit host', 'onEdit'],
    ['Remove', 'onRemove']
  ] as const)('delivers %s only after the action sheet closes', (label, callback) => {
    const { actions, spies } = build()
    const held: { tree: ReactTestRenderer | null } = { tree: null }
    act(() => {
      held.tree = create(
        createElement(ActionSheetModal, {
          visible: true,
          actions,
          onClose: spies.onDismiss
        })
      )
      renderer = held.tree
    })
    const rendered = held.tree
    if (!rendered) {
      throw new Error('Action sheet did not render')
    }
    const button = rendered.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) =>
        node
          .findAll((text) => String(text.type) === 'Text')
          .some((text) => text.props.children === label)
      )
    if (!button) {
      throw new Error(`Missing action ${label}`)
    }
    act(() => button.props.onPress())
    expect(spies.onDismiss).toHaveBeenCalledOnce()
    expect(spies.onDiagnostics).not.toHaveBeenCalled()
    expect(spies.onEdit).not.toHaveBeenCalled()
    expect(spies.onRemove).not.toHaveBeenCalled()

    const closed = rendered.root.find((node) => String(node.type) === 'BottomDrawer').props
      .onAfterClose
    act(() => closed())
    expect(spies[callback]).toHaveBeenCalledExactlyOnceWith(label === 'Remove' ? HOST : HOST.id)
    act(() => closed())
    expect(spies[callback]).toHaveBeenCalledOnce()
  })
})
