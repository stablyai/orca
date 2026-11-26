import { describe, expect, it } from 'vitest'
import { BOT_SLACK_CHANNEL_HELLO_SET_METHOD } from '../../../shared/rpc-contract/bots-slack-channel-hello-params'
import { OrchestrationRequestEvidence } from './orchestration-compatibility-envelope'

// The host checks turning a bot's Slack intro off against the chat it verifies, so a bot chat's CLI
// must send that chat's session evidence with the call.
describe('the Slack intro switch’s caller evidence', () => {
  it('names the chat the command ran in', () => {
    const envelope = new OrchestrationRequestEvidence({
      ORCA_AGENT_SESSION_ID: 'scout-chat'
    }).envelopeFor(BOT_SLACK_CHANNEL_HELLO_SET_METHOD, {
      remote: false,
      mutation: true,
      requestId: undefined
    })
    expect(envelope.orchestrationCompatibilityEvidence?.agentSessionId).toBe('scout-chat')
  })
})
