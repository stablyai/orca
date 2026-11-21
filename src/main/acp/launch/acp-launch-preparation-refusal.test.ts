import { expect, it } from 'vitest'
import { AgentSessionAcquisitionRefusal } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../../antigravity/antigravity-acp-launch-spec'
import { prepareAcpLaunch } from './acp-structured-launch-preparation'

it("keeps an account's own refusal, so the chat says it isn't signed in instead of failing to start", async () => {
  const refusal = new AgentSessionAcquisitionRefusal('No key', 'notSignedIn', 'managed')
  const launch = {
    command: '/orca/agy_acp_server.par',
    env: {},
    spec: {
      ...ANTIGRAVITY_LAUNCH_SPEC,
      managedRuntime: undefined,
      account: {
        ...ANTIGRAVITY_LAUNCH_SPEC.account,
        prepare: async () => {
          throw refusal
        }
      }
    }
  }
  await expect(
    prepareAcpLaunch(
      async () => launch,
      () => undefined
    )
  ).rejects.toBe(refusal)
})
