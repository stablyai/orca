import { describe, expect, it, vi } from 'vitest'
import { MOBILE_TERMINAL_CREATE_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE } from '../../../src/shared/legacy-terminal-attribution-env'
import { assertMobileTerminalAttributionDisableSupported } from './mobile-terminal-attribution-compat'

function status(result: unknown) {
  return {
    id: 'status',
    ok: true as const,
    result: { runtimeId: 'runtime', ...(result as object) },
    _meta: { runtimeId: 'runtime' }
  }
}

describe('mobile terminal attribution compatibility', () => {
  it('refuses hosts before terminal creation environment forwarding', async () => {
    const sendRequest = vi.fn().mockResolvedValue(
      status({
        capabilities: [
          'runtime.status.compat.v1',
          'runtime.environments.v1',
          'mobile.tasks.v1',
          'workspace-run-context.v1'
        ]
      })
    )

    await expect(assertMobileTerminalAttributionDisableSupported({ sendRequest })).rejects.toThrow(
      MOBILE_TERMINAL_CREATE_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE
    )
    expect(sendRequest).toHaveBeenCalledWith('status.get', undefined, {
      timeoutMs: 30_000,
      budgetSpansConnect: true
    })
  })

  it('rejects historical hosts without explicit removal capability', async () => {
    const sendRequest = vi.fn().mockResolvedValue(status({ appVersion: '1.4.90' }))

    await expect(assertMobileTerminalAttributionDisableSupported({ sendRequest })).rejects.toThrow(
      MOBILE_TERMINAL_CREATE_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE
    )
  })

  it('accepts capability-proven current development hosts', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValue(
        status({ appVersion: '0.0.0-dev', capabilities: ['terminal.attribution-removed.v1'] })
      )

    await expect(assertMobileTerminalAttributionDisableSupported({ sendRequest })).resolves.toEqual(
      { runtimeId: 'runtime' }
    )
  })

  it('fails closed when host status cannot be verified', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      id: 'status',
      ok: false,
      error: { code: 'offline', message: 'Host is offline' },
      _meta: { runtimeId: 'runtime' }
    })

    await expect(assertMobileTerminalAttributionDisableSupported({ sendRequest })).rejects.toThrow(
      'Host is offline'
    )
  })

  it('fails closed with an actionable error for malformed host status', async () => {
    const sendRequest = vi.fn().mockResolvedValue(
      status({
        appVersion: 1.49,
        capabilities: 'terminal.attribution-removed.v1'
      })
    )

    await expect(assertMobileTerminalAttributionDisableSupported({ sendRequest })).rejects.toThrow(
      'Update the host and try again'
    )
  })
})
