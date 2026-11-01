import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '../transport/types'
import { MobileHomeTasksAndAutomations } from './MobileHomeTasksAndAutomations'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  CalendarClock: 'CalendarClock',
  ChevronRight: 'ChevronRight',
  ListTodo: 'ListTodo'
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

describe('Home Tasks and Automations sections', () => {
  let tree: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  function render(connectedHosts: HostProfile[]) {
    const callbacks = { onOpenTasks: vi.fn(), onOpenAutomations: vi.fn() }
    act(() => {
      tree = create(createElement(MobileHomeTasksAndAutomations, { connectedHosts, ...callbacks }))
    })
    return callbacks
  }

  function row(label: string): ReactTestInstance {
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

  it('opens the only connected host from the Automations row, placed right after Tasks', () => {
    const callbacks = render([host('desk')])
    const rows = tree!.root.findAll((node) => String(node.type) === 'Pressable')
    expect(rows.indexOf(row('Automations'))).toBe(rows.indexOf(row('Tasks')) + 1)
    expect(row('Automations').props.disabled).toBe(false)
    act(() => row('Automations').props.onPress())
    expect(callbacks.onOpenAutomations).toHaveBeenCalledExactlyOnceWith('desk')
    expect(callbacks.onOpenTasks).not.toHaveBeenCalled()
  })

  it('keeps the automation host choice independent and disables both rows without a connection', () => {
    const callbacks = render([host('desk'), host('laptop')])
    act(() => row('Automations').props.onPress())
    expect(picker('Open Automations On').props.visible).toBe(true)
    expect(picker('Open Tasks On').props.visible).toBe(false)
    act(() => picker('Open Automations On').props.onSelect('laptop'))
    act(() => picker('Open Automations On').props.onAfterClose())
    expect(callbacks.onOpenAutomations).toHaveBeenCalledExactlyOnceWith('laptop')
    expect(callbacks.onOpenTasks).not.toHaveBeenCalled()
    act(() => tree?.unmount())
    render([])
    expect(row('Tasks').props.disabled).toBe(true)
    expect(row('Automations').props.disabled).toBe(true)
  })
})
