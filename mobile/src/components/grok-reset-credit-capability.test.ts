import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const probe = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock('../transport/runtime-capability-probe', () => ({
  startRuntimeCapabilityProbe: probe.start
}))

import {
  MOBILE_GROK_RESET_CREDIT_CAPABILITY,
  useGrokResetCreditCapability
} from './grok-reset-credit-capability'

afterEach(() => {
  vi.restoreAllMocks()
  probe.start.mockReset()
})

describe('useGrokResetCreditCapability', () => {
  it('fails closed on old hosts and derives false immediately across reconnects', () => {
    const publishers = new Map<RpcClient, (capabilities: readonly string[]) => void>()
    probe.start.mockImplementation(
      (client: RpcClient, publish: (capabilities: readonly string[]) => void) => {
        publishers.set(client, publish)
        return vi.fn()
      }
    )
    const oldClient = { sendRequest: vi.fn() } as unknown as RpcClient
    const newClient = { sendRequest: vi.fn() } as unknown as RpcClient
    let renderer: ReactTestRenderer

    function Harness({ client }: { client: RpcClient }) {
      return createElement('CapabilityResult', {
        supported: useGrokResetCreditCapability(client, true)
      })
    }

    act(() => {
      renderer = create(createElement(Harness, { client: oldClient }))
    })
    act(() => publishers.get(oldClient)?.([MOBILE_GROK_RESET_CREDIT_CAPABILITY]))
    expect(renderer!.root.findByType('CapabilityResult').props.supported).toBe(true)

    act(() => renderer!.update(createElement(Harness, { client: newClient })))
    expect(renderer!.root.findByType('CapabilityResult').props.supported).toBe(false)
    act(() => publishers.get(newClient)?.([]))
    expect(renderer!.root.findByType('CapabilityResult').props.supported).toBe(false)
  })
})
