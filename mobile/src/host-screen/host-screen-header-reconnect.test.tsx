import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import type { ForceReconnect } from '../transport/rpc-client-context-contract'

vi.mock('react-native', () => ({
  Animated: { View: 'View' },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  CalendarClock: 'Icon',
  ChevronLeft: 'Icon',
  List: 'Icon',
  MoreHorizontal: 'Icon',
  PanelLeftClose: 'Icon',
  SquareTerminal: 'Icon',
  UserCircle: 'Icon'
}))
// The real menu measures its anchor in a native Modal; list its items as plain pressables instead.
vi.mock('../components/nav-bar/PullDownMenu', async () => {
  const { createElement: h } = await import('react')
  return {
    PullDownMenu: ({
      visible,
      groups
    }: {
      visible: boolean
      groups: readonly (readonly ActionSheetAction[])[]
    }) =>
      visible
        ? h(
            'Menu',
            null,
            groups.flat().map((action) =>
              h('MenuItem', {
                key: action.id ?? action.label,
                accessibilityLabel: action.label,
                disabled: action.disabled,
                onPress: action.onPress
              })
            )
          )
        : null
  }
})

import { resolveHostDisplay } from '../../../src/shared/host-display-resolution'
import { HostScreenHeader } from './host-screen-header'

// Use the unreachable verdict that offers native Reconnect to prove the page still withholds it.
function controllerWith(forceReconnectHost: ForceReconnect) {
  const fields = {
    actions: {
      leaveHost: () => {},
      navigateFromHostList: () => {},
      openCreateMenu: () => {}
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
    onHideSidebar: undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the header reads only these members on a narrow, non-embedded layout; the rest of the controller is unreachable from it.
  return fields as unknown as Parameters<typeof HostScreenHeader>[0]['controller']
}

function render(controller: ReturnType<typeof controllerWith>): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(HostScreenHeader, { controller }))
  })
  if (rendered.tree === null) {
    throw new Error('the header did not render')
  }
  return rendered.tree
}

function controls(tree: ReactTestRenderer, label: string): ReactTestInstance[] {
  return tree.root.findAll(
    (node) =>
      (String(node.type) === 'Pressable' || String(node.type) === 'MenuItem') &&
      node.props.accessibilityLabel === label
  )
}

describe("the host header's Reconnect", () => {
  it('is absent on the page, where nothing can re-dial the connection the shell owns', () => {
    expect(controls(render(controllerWith(null)), 'Reconnect')).toHaveLength(0)
  })

  it('still renders natively and re-dials this host', () => {
    const forceReconnect = vi.fn(() => Promise.resolve())
    const [control] = controls(render(controllerWith(forceReconnect)), 'Reconnect')
    act(() => {
      control?.props.onPress()
    })
    expect(forceReconnect.mock.calls).toEqual([['host-a']])
  })
})

describe("the host header's ⋯ menu", () => {
  it('holds host navigation, held while offline, and nothing the bottom bar owns', () => {
    const tree = render(controllerWith(null))
    act(() => {
      controls(tree, 'More actions')[0]?.props.onPress()
    })
    expect(controls(tree, 'Tasks')[0]?.props.disabled).toBe(true)
    expect(controls(tree, 'Accounts')[0]?.props.disabled).toBe(true)
    expect(controls(tree, 'Workspace options')).toHaveLength(0)
    expect(controls(tree, 'Search workspaces')).toHaveLength(0)
    expect(controls(tree, 'New workspace')).toHaveLength(0)
  })
})

describe('host Automations entry', () => {
  let tree: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  it.each([false, true])(
    'keeps one menu entry after Tasks with embedded=%s and disables it offline',
    (embedded) => {
      const navigate = vi.fn()
      const controller = {
        ...controllerWith(null),
        embedded,
        hostId: 'host/with space',
        actions: { ...controllerWith(null).actions, navigateFromHostList: navigate }
      }
      const screen = (connState: 'connected' | 'reconnecting') => (
        <HostScreenHeader controller={{ ...controller, connState }} />
      )
      act(() => {
        tree = create(screen('connected'))
      })
      expect(controls(tree!, 'Automations')).toHaveLength(0)
      act(() => controls(tree!, 'More actions')[0]?.props.onPress())
      const entries = () => controls(tree!, 'Automations')
      expect(entries()).toHaveLength(1)
      const menuItems = tree!.root.findAll((node) => String(node.type) === 'MenuItem')
      const entryIndex = menuItems.indexOf(entries()[0]!)
      expect(menuItems[entryIndex - 1]?.props.accessibilityLabel).toBe('Tasks')
      expect(entries()[0]?.props.disabled).toBe(false)
      act(() => entries()[0]?.props.onPress())
      expect(navigate).toHaveBeenCalledExactlyOnceWith('/h/host%2Fwith%20space/automations')
      act(() => tree?.update(screen('reconnecting')))
      expect(entries()).toHaveLength(1)
      expect(entries()[0]?.props.disabled).toBe(true)
    }
  )
})
