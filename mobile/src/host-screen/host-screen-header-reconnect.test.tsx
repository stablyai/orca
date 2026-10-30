import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ForceReconnect } from '../transport/rpc-client-context-contract'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  CalendarClock: 'Icon',
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

// Use the unreachable verdict that offers native Reconnect to prove the page still withholds it.
function controllerWith(forceReconnectHost: ForceReconnect) {
  const fields = {
    actions: {
      leaveHost: () => {},
      navigateFromHostList: () => {},
      openNewWorktreeModal: () => {}
    },
    connectionVerdict: {
      kind: 'unreachable',
      label: "Can't reach desktop",
      reason: 'never-connected'
    },
    connState: 'reconnecting',
    embedded: false,
    floatingWorkspaceEnabled: false,
    forceReconnectHost,
    hostId: 'host-a',
    hostDisplay: resolveHostDisplay({ name: 'Desk' }),
    lastConnectedAt: null,
    onHideSidebar: undefined,
    settings: { activeFilterCount: 0 },
    state: { hostName: 'Desk', view: { groupBy: 'none' }, showSearch: false }
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

describe('host Automations entry', () => {
  let tree: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  it.each([false, true])(
    'keeps one header entry with embedded=%s and disables it offline',
    (embedded) => {
      const navigate = vi.fn()
      const controller = {
        ...controllerWith(null),
        embedded,
        activeFilterCount: 0,
        hostId: 'host/with space',
        actions: { ...controllerWith(null).actions, navigateFromHostList: navigate }
      }
      const screen = (connState: 'connected' | 'reconnecting') => (
        <HostScreenHeader controller={{ ...controller, connState }} />
      )
      act(() => {
        tree = create(screen('connected'))
      })
      const entries = (): ReactTestInstance[] =>
        tree?.root.findAll(
          (node) =>
            String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Automations'
        ) ?? []
      expect(entries()).toHaveLength(1)
      const entry = entries()[0]
      const toolbarButtons =
        entry?.parent?.findAll((node) => String(node.type) === 'Pressable') ?? []
      const entryIndex = entry ? toolbarButtons.indexOf(entry) : -1
      expect(toolbarButtons?.[entryIndex - 1]?.props.accessibilityLabel).toBe('Tasks')
      expect(entries()[0]?.props.disabled).toBe(false)
      act(() => entries()[0]?.props.onPress())
      expect(navigate).toHaveBeenCalledExactlyOnceWith('/h/host%2Fwith%20space/automations')
      act(() => tree?.update(screen('reconnecting')))
      expect(entries()).toHaveLength(1)
      expect(entries()[0]?.props.disabled).toBe(true)
    }
  )
})
