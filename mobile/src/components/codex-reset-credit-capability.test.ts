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
  readCodexResetCreditCapability,
  useCodexResetCreditCapability
} from './codex-reset-credit-capability'

afterEach(() => {
  vi.restoreAllMocks()
  probe.start.mockReset()
})

describe('readCodexResetCreditCapability', () => {
  it('enables reset only when the host explicitly advertises the contract', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { capabilities: ['mobile.tasks.v1', MOBILE_CODEX_RESET_CREDIT_CAPABILITY] }
    })

    await expect(readCodexResetCreditCapability({ sendRequest })).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledWith('status.get')
  })

  it.each([
    { ok: true, result: { capabilities: ['mobile.tasks.v1'] } },
    { ok: true, result: { capabilities: 'accounts.codex-reset-credit.v1' } },
    { ok: false, error: { code: 'old-host', message: 'unsupported' } }
  ])('fails closed for an unsupported or malformed host response', async (response) => {
    const sendRequest = vi.fn().mockResolvedValue(response)
    await expect(readCodexResetCreditCapability({ sendRequest })).resolves.toBe(false)
  })

  it('fails closed when the capability probe cannot complete', async () => {
    const sendRequest = vi.fn().mockRejectedValue(new Error('connection lost'))
    await expect(readCodexResetCreditCapability({ sendRequest })).resolves.toBe(false)
  })
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
    expect(renderer!.root.findByType('CapabilityResult').props.supported).toBe(false)

    act(() => publish?.([MOBILE_CODEX_RESET_CREDIT_CAPABILITY]))
    expect(renderer!.root.findByType('CapabilityResult').props.supported).toBe(true)

    act(() => renderer!.unmount())
    expect(cancel).toHaveBeenCalledOnce()
  })
})
