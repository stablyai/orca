import { describe, expect, it } from 'vitest'
import { OrchestrationRequestEvidence } from '../../../../cli/orchestration/identity/orchestration-compatibility-envelope'
import { BOT_SLACK_CHANNEL_HELLO_SET_METHOD } from '../../../../shared/rpc-contract/bots-slack-channel-hello-params'
import { needsOrchestrationCallerResolution } from '../orchestration/callers/orchestration-session-caller'

// Turning the intro off from a bot's chat is checked against the turn the host verifies, so the CLI
// must send its chat's session evidence with it and the host must resolve it.
describe('bots.slackChannelHello.set caller evidence', () => {
  it('goes from a bot chat’s CLI to the host, which resolves the session it names', () => {
    const envelope = new OrchestrationRequestEvidence({
      ORCA_AGENT_SESSION_ID: 'scout-chat'
    }).envelopeFor(BOT_SLACK_CHANNEL_HELLO_SET_METHOD, {
      remote: false,
      mutation: true,
      requestId: undefined
    })
    expect(envelope.orchestrationCompatibilityEvidence?.agentSessionId).toBe('scout-chat')
    expect(
      needsOrchestrationCallerResolution(
        {
          id: 'r1',
          authToken: 't',
          method: BOT_SLACK_CHANNEL_HELLO_SET_METHOD,
          params: {},
          ...envelope
        },
        undefined
      )
    ).toBe(true)
  })
})
