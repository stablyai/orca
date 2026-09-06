import { describe, expect, it } from 'vitest'
import { projectHostSessionRuntimeCapabilities } from './host-session-runtime-capabilities'

describe('host session runtime capabilities', () => {
  it('projects only the reviewed Session feature gates', () => {
    expect(
      projectHostSessionRuntimeCapabilities([
        'browser.screencast.v1',
        'aiVault.v1',
        'terminal.quick-commands.v1',
        'terminal.query-reply-input.v1',
        'secret.unreviewed.v1'
      ])
    ).toEqual({
      browserScreencastSupported: true,
      agentHistorySupported: true,
      quickCommandsSupported: true,
      terminalQueryReplyInputSupported: true
    })
    expect(projectHostSessionRuntimeCapabilities(['secret.unreviewed.v1'])).toEqual({
      browserScreencastSupported: false,
      agentHistorySupported: false,
      quickCommandsSupported: false,
      terminalQueryReplyInputSupported: false
    })
  })
})
