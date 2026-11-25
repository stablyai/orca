import { describe, expect, it } from 'vitest'
import { BOT_SLACK_CHANNEL_HELLO_SET_METHOD } from '../../../../shared/rpc-contract/bots-slack-channel-hello-params'
import { needsOrchestrationCallerResolution } from '../orchestration/callers/orchestration-session-caller'

// Turning the intro off from a bot's chat is checked against the turn the host verifies, so the host
// must resolve the session the CLI's evidence names (the CLI side: orchestration-compatibility-envelope).
describe('bots.slackChannelHello.set caller evidence', () => {
  it('has the host resolve the session a bot chat’s evidence names', () => {
    expect(
      needsOrchestrationCallerResolution(
        {
          id: 'r1',
          authToken: 't',
          method: BOT_SLACK_CHANNEL_HELLO_SET_METHOD,
          params: {},
          orchestrationCompatibilityEvidence: { agentSessionId: 'scout-chat' }
        },
        undefined
      )
    ).toBe(true)
  })
})
