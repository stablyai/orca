import { describe, expect, it, vi } from 'vitest'
import { getHostListActionSheetActions } from './host-list-action-sheet-actions'
import type { ConnectionState, HostProfile } from './transport/types'

vi.mock('lucide-react-native', () => ({
  Activity: vi.fn(),
  Edit3: vi.fn(),
  PowerOff: vi.fn(),
  RefreshCw: vi.fn()
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

describe('getHostListActionSheetActions', () => {
  // Why: these navigate or open a second drawer. Presenting while this sheet's native
  // Modal is still up freezes the whole screen on iOS — issue #8791.
  it.each(['Network diagnostics', 'Edit host', 'Remove'])(
    'defers %s until the action sheet has closed',
    (label) => {
      const { actions } = build()
      expect(actions.find((action) => action.label === label)).toMatchObject({
        closeBeforePress: true
      })
    }
  )

  it('leaves the in-place actions undeferred so they fire on tap', () => {
    const { actions, spies } = build()
    const disconnect = actions.find((action) => action.label === 'Disconnect')
    expect(disconnect?.closeBeforePress).toBeUndefined()
    disconnect?.onPress()
    expect(spies.onDisconnect).toHaveBeenCalledWith(HOST.id)
    expect(spies.onDismiss).toHaveBeenCalled()
  })

  it('hands Remove the whole host so the confirm sheet can name it', () => {
    const { actions, spies } = build()
    actions.find((action) => action.label === 'Remove')?.onPress()
    expect(spies.onRemove).toHaveBeenCalledWith(HOST)
  })

  it('routes Edit host to the edit screen', () => {
    const { actions, spies } = build()
    actions.find((action) => action.label === 'Edit host')?.onPress()
    expect(spies.onEdit).toHaveBeenCalledWith(HOST.id)
  })

  it('routes Network diagnostics with the selected host', () => {
    const { actions, spies } = build()
    actions.find((action) => action.label === 'Network diagnostics')?.onPress()
    expect(spies.onDiagnostics).toHaveBeenCalledWith(HOST.id)
  })

  it('offers Disconnect only while the socket is live', () => {
    expect(build({ state: 'reconnecting' }).actions.map((action) => action.label)).toEqual([
      'Reconnect',
      'Disconnect',
      'Network diagnostics',
      'Edit host',
      'Remove'
    ])
    expect(build({ state: 'disconnected' }).actions.map((action) => action.label)).toEqual([
      'Connect',
      'Network diagnostics',
      'Edit host',
      'Remove'
    ])
  })

  it('says Connect until the host has connected at least once this session', () => {
    expect(build({ hasEverConnected: false }).actions[0]?.label).toBe('Connect')
    expect(build({ hasEverConnected: true }).actions[0]?.label).toBe('Reconnect')
  })

  it('renders nothing without a target host', () => {
    expect(
      getHostListActionSheetActions({
        host: null,
        state: 'disconnected',
        hasEverConnected: false,
        onDismiss: vi.fn(),
        onReconnect: vi.fn(),
        onDisconnect: vi.fn(),
        onDiagnostics: vi.fn(),
        onEdit: vi.fn(),
        onRemove: vi.fn()
      })
    ).toEqual([])
  })
})
