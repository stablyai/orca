import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bridgeProcessArgs,
  createDesktopScriptProviderClient,
  expectDesktopProviderSubprocessStartCount,
  mockBridgeProcessFailure,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness
} from './desktop-script-provider-test-harness'
import type { BridgeResponse } from './desktop-script-provider-types'
import type { DesktopScriptRuntimeHost } from './desktop-script-runtime-host'
import { RuntimeClientError } from './runtime-client-error'

const POLICY_STDERR =
  'File runtime.ps1 cannot be loaded because running scripts is disabled on this system. + CategoryInfo : SecurityError'

function fakeRuntimeHost(request: DesktopScriptRuntimeHost['request']) {
  const dispose = vi.fn()
  return { host: { request, dispose } as unknown as DesktopScriptRuntimeHost, dispose }
}

describe('desktop script provider runtime host routing', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('maps runtime host operation failures without falling back to the one-shot bridge', async () => {
    const { host } = fakeRuntimeHost(
      vi.fn(async () => ({ ok: false, error: 'appBlocked("1Password")' }) as BridgeResponse)
    )

    const client = await createDesktopScriptProviderClient('windows', 'C:\\runtime.ps1', host)

    await expect(client.listApps()).rejects.toMatchObject({ code: 'app_blocked' })
    expectDesktopProviderSubprocessStartCount(0)
  })

  it('returns to the runtime host once it recovers', async () => {
    let healthy = false
    const request = vi.fn(async () => {
      if (!healthy) {
        throw new RuntimeClientError('runtime_host_unavailable', 'could not start')
      }
      return { ok: true, apps: [] } as BridgeResponse
    })
    const { host } = fakeRuntimeHost(request)
    mockBridgeResponse({ ok: true, apps: [] })

    const client = await createDesktopScriptProviderClient('windows', 'C:\\runtime.ps1', host)

    await client.listApps()
    expectDesktopProviderSubprocessStartCount(1)

    healthy = true
    await expect(client.listApps()).resolves.toEqual({ apps: [] })
    expectDesktopProviderSubprocessStartCount(1)
  })

  it('runs the one-shot bridge under RemoteSigned and falls back to Bypass once', async () => {
    mockBridgeProcessFailure(POLICY_STDERR)
    mockBridgeResponse({ ok: true, apps: [] })

    const client = await createDesktopScriptProviderClient('windows', 'C:\\runtime.ps1')

    await expect(client.listApps()).resolves.toEqual({ apps: [] })
    expectDesktopProviderSubprocessStartCount(2)
    expect(bridgeProcessArgs(0)).toContain('-NoLogo')
    expect(bridgeProcessArgs(0)).toContain('RemoteSigned')
    expect(bridgeProcessArgs(0)).not.toContain('Bypass')
    expect(bridgeProcessArgs(1)).toContain('Bypass')
  })

  it('never replays an operation whose own output merely mentions a policy error', async () => {
    // Untrusted window titles and element names must never trigger an operation replay.
    mockBridgeProcessFailure({
      stdout: JSON.stringify({
        ok: true,
        snapshot: { windowTitle: 'SecurityError - UnauthorizedAccess.log - Notepad' }
      }),
      stderr: ''
    })

    const client = await createDesktopScriptProviderClient('windows', 'C:\\runtime.ps1')

    await expect(client.listApps()).rejects.toBeInstanceOf(Error)
    expectDesktopProviderSubprocessStartCount(1)
  })
})
