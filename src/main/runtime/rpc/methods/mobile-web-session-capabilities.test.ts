import { describe, expect, it } from 'vitest'
import { MobileWebSessionHostGatesResultSchema } from '../../../../shared/mobile-web/session-operation-contract'
import { MOBILE_WEB_SESSION_CAPABILITIES_METHOD } from './mobile-web-session-capabilities'
import { sessionFixture } from './mobile-web-session-test-fixture'
import { projectHostSessionRuntimeCapabilities } from '../../../../shared/mobile-web/session-runtime-capabilities'

describe('session capabilities', () => {
  it('publishes bounded capability tokens and keeps credentials out of page results', () => {
    const f = sessionFixture()
    f.runtime.getStatus = () =>
      ({
        capabilities: [
          'browser.screencast.v1',
          'aiVault.v1',
          'terminal.quick-commands.v1',
          'terminal.query-reply-input.v1',
          'x'.repeat(121)
        ],
        floatingWorkspaceEnabled: true,
        deviceToken: 'secret'
      }) as never
    const result = MOBILE_WEB_SESSION_CAPABILITIES_METHOD.handler(null, f.context)
    const { hostCapabilities } = MobileWebSessionHostGatesResultSchema.parse(result)
    expect(hostCapabilities).toHaveLength(4)
    expect(projectHostSessionRuntimeCapabilities(hostCapabilities)).toEqual({
      browserScreencastSupported: true,
      agentHistorySupported: true,
      quickCommandsSupported: true,
      terminalQueryReplyInputSupported: true
    })
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})
