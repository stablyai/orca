import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureServer: vi.fn(),
  dial: vi.fn()
}))

vi.mock('./tailcat-tunnel-dialer-registration', () => ({
  getTailcatTunnelService: () => mocks,
  disposeTailcatTunnel: vi.fn()
}))

import { attachTailcatTunnel } from './tailcat-tunnel-host'

function rpc(hasTunnelGrants: boolean) {
  return {
    getWebSocketEndpoint: () => 'ws://127.0.0.1:6768',
    hasTunnelGrants: () => hasTunnelGrants,
    setTunnelAdvertiser: vi.fn()
  }
}

describe('attachTailcatTunnel', () => {
  beforeEach(() => {
    mocks.ensureServer.mockReset()
    mocks.dial.mockReset()
  })

  it('propagates an explicitly requested server startup failure', async () => {
    const failure = new Error('tailcat missing')
    mocks.ensureServer.mockRejectedValueOnce(failure)

    await expect(attachTailcatTunnel(rpc(false), '/tmp/orca', { startServer: true })).rejects.toBe(
      failure
    )
  })

  it('keeps persisted-grant restoration best-effort', async () => {
    const failure = new Error('tailcat missing')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.ensureServer.mockRejectedValueOnce(failure)

    try {
      await expect(attachTailcatTunnel(rpc(true), '/tmp/orca')).resolves.toBe(mocks)
      expect(report).toHaveBeenCalledWith('[tunnel] Tailcat tunnel did not start:', failure)
    } finally {
      report.mockRestore()
    }
  })
})
