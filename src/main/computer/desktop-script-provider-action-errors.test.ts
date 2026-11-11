import { afterEach, describe, expect, it } from 'vitest'
import {
  createDesktopScriptProviderClient,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness
} from './desktop-script-provider-test-harness'

describe('DesktopScriptProviderClient action errors', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('does not confuse accessibility permission failures with missing windows', async () => {
    mockBridgeResponse({
      ok: false,
      error:
        "app 'Text Editor' has visible windows but no accessibility window. Accessibility permission may need to be toggled."
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'permission_denied'
    })
  })
})
