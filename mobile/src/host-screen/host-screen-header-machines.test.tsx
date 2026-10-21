import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Box: 'Icon',
  ChevronLeft: 'Icon',
  List: 'Icon',
  PanelLeftClose: 'Icon',
  Plus: 'Icon',
  Search: 'Icon',
  SquareTerminal: 'Icon',
  UserCircle: 'Icon',
  X: 'Icon'
}))

import { resolveHostDisplay } from '../../../src/shared/host-display-resolution'
import { HostScreenHeader } from './host-screen-header'

function render(machinesAvailable: boolean, navigateFromHostList: (path: string) => void) {
  const fields = {
    actions: { leaveHost: () => {}, navigateFromHostList, openNewWorktreeModal: () => {} },
    connState: 'connected',
    embedded: false,
    floatingWorkspaceEnabled: false,
    forceReconnectHost: null,
    hostId: 'host a',
    hostDisplay: resolveHostDisplay({ name: 'Desk' }),
    lastConnectedAt: null,
    machinesAvailable,
    onHideSidebar: undefined,
    reconnectAttempts: 0,
    relayRecovery: {
      pendingPath: null,
      pairingRejected: false,
      relayHostReachability: 'connected'
    },
    settings: { activeFilterCount: 0 },
    state: { hostName: 'Desk', view: { groupBy: 'none' }, showSearch: false }
  }
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(
      createElement(HostScreenHeader, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the narrow header reads only these controller members.
        controller: fields as unknown as Parameters<typeof HostScreenHeader>[0]['controller']
      })
    )
  })
  return rendered.tree!.root.findAll(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Machines'
  )
}

describe("the host header's Machines entry", () => {
  it('is hidden unless the desktop answered with machine providers', () => {
    expect(render(false, () => {})).toHaveLength(0)
  })

  it('opens the host machines page', () => {
    const navigate = vi.fn()
    const [button] = render(true, navigate)
    act(() => button!.props.onPress())
    expect(navigate).toHaveBeenCalledWith('/h/host%20a/machines')
  })
})
