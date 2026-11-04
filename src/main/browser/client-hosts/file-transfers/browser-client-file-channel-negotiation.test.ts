import { describe, expect, it } from 'vitest'

import { BrowserClientHostAttachParams } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'

describe('browser file channel negotiation', () => {
  it('rejects an attach that asks for the file channel without command negotiation', () => {
    expect(
      BrowserClientHostAttachParams.safeParse({
        authorityRuntimeId: 'runtime-1',
        browserHostClientId: 'host-1',
        hostCapabilities: ['webview'],
        fileChannelProtocolVersion: 1
      }).success
    ).toBe(false)
  })
})
