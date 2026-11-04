import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '../transport/types'
import { MobileHomeTasksSection } from './MobileHomeTasksSection'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
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

describe('Home Tasks section', () => {
  let tree: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  function render(connectedHosts: HostProfile[]) {
    const onOpen = vi.fn()
    act(() => {
      tree = create(createElement(MobileHomeTasksSection, { connectedHosts, first: false, onOpen }))
    })
    return onOpen
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

  it('opens the only connected host from the Tasks row', () => {
    const onOpen = render([host('desk')])
    expect(row('Tasks').props.disabled).toBe(false)
    act(() => row('Tasks').props.onPress())
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('desk')
  })

  it('asks which desktop when several are connected, and is disabled without a connection', () => {
    const onOpen = render([host('desk'), host('laptop')])
    act(() => row('Tasks').props.onPress())
    expect(picker('Open Tasks On').props.visible).toBe(true)
    act(() => picker('Open Tasks On').props.onSelect('laptop'))
    act(() => picker('Open Tasks On').props.onAfterClose())
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('laptop')
    act(() => tree?.unmount())
    render([])
    expect(row('Tasks').props.disabled).toBe(true)
  })
})
