import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '../transport/types'
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

  it('runs the action on the only offered host without a picker', () => {
    render([desk, laptop])
    const action = vi.fn()

    pickHost(action, [laptop])

    expect(action).toHaveBeenCalledWith('laptop')
    expect(picker().visible).toBe(false)
  })

  it('offers only the hosts passed in', () => {
    render([desk, laptop, server])
    const action = vi.fn()

    pickHost(action, [desk, server])

    expect(picker().visible).toBe(true)
    expect(picker().options.map((option) => option.value)).toEqual(['desk', 'server'])
    act(() => picker().onSelect('server'))
    act(() => picker().onAfterClose())
    expect(action).toHaveBeenCalledWith('server')
  })

  it('runs nothing when the picker is dismissed', () => {
    render([desk, laptop])
    const action = vi.fn()

    pickHost(action)
    act(() => picker().onClose())
    act(() => picker().onAfterClose())

    expect(picker().visible).toBe(false)
    expect(action).not.toHaveBeenCalled()
  })

  it('disambiguates path-routed hosts without exposing endpoint paths', () => {
    render([
      host('desk-a', 'Desk', 'wss://gateway.example.com/v1/connect/bearer-secret-a'),
      host('desk-b', 'Desk', 'wss://gateway.example.com/v1/connect/bearer-secret-b')
    ])

    pickHost(vi.fn())

    expect(picker().options).toEqual([
      { value: 'desk-a', label: 'Desk', subtitle: 'gateway.example.com · desk-a' },
      { value: 'desk-b', label: 'Desk', subtitle: 'gateway.example.com · desk-b' }
    ])
    expect(JSON.stringify(picker().options)).not.toContain('bearer-secret')
  })

  it('does not expose malformed legacy endpoint details', () => {
    render([
      host('desk-a', 'Desk', 'gateway.example.com/v1/connect/bearer-secret?token=query-secret'),
      host('desk-b', 'Desk', 'localhost:6768/private-secret')
    ])

    pickHost(vi.fn())

    expect(picker().options).toEqual([
      { value: 'desk-a', label: 'Desk', subtitle: 'Unknown endpoint · desk-a' },
      { value: 'desk-b', label: 'Desk', subtitle: 'Unknown endpoint · desk-b' }
    ])
    expect(JSON.stringify(picker().options)).not.toContain('secret')
  })

  it('closes a stale picker when an offered host disconnects', () => {
    const rerender = render([desk, laptop])

    pickHost(vi.fn())
    expect(picker().visible).toBe(true)

    rerender([desk])
    expect(picker().visible).toBe(false)
  })

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
