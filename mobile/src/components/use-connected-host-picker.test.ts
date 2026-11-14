import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '../host-catalog/host-profile'
import { useConnectedHostPicker } from './use-connected-host-picker'

function host(id: string, name: string, endpoint: string): HostProfile {
  return {
    id,
    name,
    endpoint,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 1
  }
}

const desk = host('desk', 'Desk', 'ws://192.168.1.2:6768')
const laptop = host('laptop', 'Laptop', 'wss://relay.example.com/mobile')
const server = host('server', 'Server', 'wss://ssh.example.com/mobile')

describe('useConnectedHostPicker', () => {
  let renderer: ReactTestRenderer | null = null
  const handle: { current: ReturnType<typeof useConnectedHostPicker> | null } = { current: null }

  function Harness(props: { hosts: HostProfile[] }) {
    handle.current = useConnectedHostPicker(props.hosts)
    return null
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    handle.current = null
  })

  function render(hosts: HostProfile[]) {
    act(() => {
      renderer = create(createElement(Harness, { hosts }))
    })
    return (next: HostProfile[]) =>
      act(() => renderer!.update(createElement(Harness, { hosts: next })))
  }

  function picker() {
    return handle.current!.pickerProps
  }

  function pickHost(action: (hostId: string) => void, hosts?: HostProfile[]) {
    act(() => handle.current!.pickHost(action, hosts))
  }

  it('does not reopen a stale picker if its old host set returns while closing', () => {
    const rerender = render([desk, laptop])
    const action = vi.fn()

    pickHost(action)
    rerender([desk])
    rerender([desk, laptop])

    expect(picker().visible).toBe(false)
    act(() => picker().onAfterClose())
    expect(action).not.toHaveBeenCalled()
  })

  it('keeps a selected host through an unrelated topology change while closing', () => {
    const rerender = render([desk, laptop])
    const action = vi.fn()

    pickHost(action)
    act(() => picker().onSelect('laptop'))
    rerender([desk, laptop, server])
    act(() => picker().onAfterClose())

    expect(action).toHaveBeenCalledWith('laptop')
  })

  it('drops a selection that disconnects while the picker is closing', () => {
    const rerender = render([desk, laptop])
    const action = vi.fn()

    pickHost(action)
    act(() => picker().onSelect('laptop'))
    rerender([desk])
    act(() => picker().onAfterClose())

    expect(action).not.toHaveBeenCalled()
  })
})
