import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ForceReconnect } from '../transport/rpc-client-context-contract'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  Filter: 'Icon',
  Layers: 'Icon',
  List: 'Icon',
  PanelLeftClose: 'Icon',
  Plus: 'Icon',
  Search: 'Icon',
  SlidersHorizontal: 'Icon',
  SquareTerminal: 'Icon',
  UserCircle: 'Icon',
  X: 'Icon'
}))

import { resolveHostDisplay } from '../../../src/shared/host-display-resolution'
import { HostScreenHeader } from './host-screen-header'

/** A host the shell's client has failed to reach twenty times, which is the verdict that offers
 *  Reconnect on native. */
function controllerWith(forceReconnectHost: ForceReconnect) {
  const fields = {
    actions: {
      leaveHost: () => {},
      navigateFromHostList: () => {},
      openNewWorktreeModal: () => {}
    },
    connState: 'reconnecting',
    embedded: false,
    floatingWorkspaceEnabled: false,
    forceReconnectHost,
    hostId: 'host-a',
    hostDisplay: resolveHostDisplay({ name: 'Desk' }),
    lastConnectedAt: null,
    onHideSidebar: undefined,
    reconnectAttempts: 20,
    relayRecovery: {
      pendingPath: null,
      pairingRejected: false,
      relayHostReachability: 'connecting'
    },
    settings: { activeFilterCount: 0, selectedSortLabel: 'Recent' },
    state: { hostName: 'Desk', groupMode: 'none', showSearch: false }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the header reads only these members on a narrow, non-embedded layout; the rest of the controller is unreachable from it.
  return fields as unknown as Parameters<typeof HostScreenHeader>[0]['controller']
}

function render(forceReconnectHost: ForceReconnect): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(
      createElement(HostScreenHeader, { controller: controllerWith(forceReconnectHost) })
    )
  })
  if (rendered.tree === null) {
    throw new Error('the header did not render')
  }
  return rendered.tree
}

function reconnectControls(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAll(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Reconnect'
  )
}

describe("the host header's Reconnect", () => {
  it('is absent on the page, where nothing can re-dial the connection the shell owns', () => {
    expect(reconnectControls(render(null))).toHaveLength(0)
  })

  it('still renders natively and re-dials this host', () => {
    const forceReconnect = vi.fn(() => Promise.resolve())
    const [control] = reconnectControls(render(forceReconnect))
    act(() => {
      control?.props.onPress()
    })
    expect(forceReconnect.mock.calls).toEqual([['host-a']])
  })
})
