import { afterEach, describe, expect, it } from 'vitest'
import {
  bridgeProcessArgs,
  createDesktopScriptProviderClient,
  expectDesktopProviderSubprocessStartCount,
  mockBridgeProcessFailure,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness
} from '../desktop-script-provider-test-harness'

const POLICY_STDERR =
  'File runtime.ps1 cannot be loaded because running scripts is disabled on this system. + CategoryInfo : SecurityError'

describe('desktop script provider runtime host routing', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

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
})
