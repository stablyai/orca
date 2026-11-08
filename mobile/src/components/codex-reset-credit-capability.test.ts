import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const probe = vi.hoisted(() => ({
  start: vi.fn()
}))

vi.mock('../transport/runtime-capability-probe', () => ({
  startRuntimeCapabilityProbe: probe.start
}))

import {
  MOBILE_CODEX_RESET_CREDIT_CAPABILITY,
  useCodexResetCreditCapability
} from './codex-reset-credit-capability'
import { findByHostType } from '../test-support/react-test-renderer-host-nodes'

afterEach(() => {
  vi.restoreAllMocks()
  probe.start.mockReset()
})

describe('useCodexResetCreditCapability', () => {
  it('uses the reconnect-safe probe and cancels it on unmount', () => {
    const cancel = vi.fn()
    let publish: ((capabilities: readonly string[]) => void) | null = null
    probe.start.mockImplementation(
      (_client: RpcClient, onCapabilities: (capabilities: readonly string[]) => void) => {
        publish = onCapabilities
        return cancel
      }
    )
    const client = { sendRequest: vi.fn() } as unknown as RpcClient
    let renderer: ReactTestRenderer | null = null

    function Harness() {
      const supported = useCodexResetCreditCapability(client, true)
      return createElement('CapabilityResult', { supported })
    }

    act(() => {
      renderer = create(createElement(Harness))
    })
    expect(findByHostType(renderer!.root, 'CapabilityResult').props.supported).toBe(false)

    act(() => publish?.([MOBILE_CODEX_RESET_CREDIT_CAPABILITY]))
    expect(findByHostType(renderer!.root, 'CapabilityResult').props.supported).toBe(true)

    act(() => renderer!.unmount())
    expect(cancel).toHaveBeenCalledOnce()
  })
})
