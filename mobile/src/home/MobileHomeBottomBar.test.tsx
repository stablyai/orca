import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '../transport/types'
import { MobileHomeBottomBar } from './MobileHomeBottomBar'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  CalendarClock: 'CalendarClock',
  ListTodo: 'ListTodo',
  Plus: 'Plus',
  QrCode: 'QrCode'
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))

function host(id: string): HostProfile {
  return {
    id,
    name: id,
    endpoint: `ws://${id}.local:6768`,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 1
  }
}

describe('Home bottom-bar Automations entry', () => {
  let tree: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  function render(connectedHosts: HostProfile[]) {
    const callbacks = {
      onOpenTasks: vi.fn(),
      onOpenAutomations: vi.fn(),
      onCreateWorkspace: vi.fn()
    }
    act(() => {
      tree = create(
        createElement(MobileHomeBottomBar, {
          bottomInset: 0,
          contentMaxWidth: 600,
          isWideLayout: false,
          connectedHosts,
          ...callbacks
        })
      )
    })
    return callbacks
  }

  function button(label: string): ReactTestInstance {
    return tree!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) =>
        node
          .findAll((child) => String(child.type) === 'Text')
          .some((child) => child.props.children === label)
      )!
  }

  function picker(title: string): ReactTestInstance {
    return tree!.root
      .findAll((node) => String(node.type) === 'PickerModal')
      .find((node) => node.props.title === title)!
  }

  it('opens the only connected host from the button immediately after Tasks', () => {
    const callbacks = render([host('desk')])
    const buttons = tree!.root.findAll((node) => String(node.type) === 'Pressable')
    expect(buttons.indexOf(button('Automations'))).toBe(buttons.indexOf(button('Tasks')) + 1)
    expect(button('Automations').props.disabled).toBe(false)
    act(() => button('Automations').props.onPress())
    expect(callbacks.onOpenAutomations).toHaveBeenCalledExactlyOnceWith('desk')
    expect(callbacks.onOpenTasks).not.toHaveBeenCalled()
  })

  it('keeps the automation host choice independent and disables the entry without a connection', () => {
    const callbacks = render([host('desk'), host('laptop')])
    act(() => button('Automations').props.onPress())
    expect(picker('Open Automations On').props.visible).toBe(true)
    expect(picker('Open Tasks On').props.visible).toBe(false)
    act(() => picker('Open Automations On').props.onSelect('laptop'))
    act(() => picker('Open Automations On').props.onAfterClose())
    expect(callbacks.onOpenAutomations).toHaveBeenCalledExactlyOnceWith('laptop')
    expect(callbacks.onOpenTasks).not.toHaveBeenCalled()
    act(() => tree?.unmount())
    render([])
    expect(button('Tasks').props.disabled).toBe(true)
    expect(button('Automations').props.disabled).toBe(true)
  })
})
