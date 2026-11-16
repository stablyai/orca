import { afterEach, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import { GROK, openAcpAdapterRig } from '../acp/session/testing/acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const MANAGED = acpLaunchSpecFor('antigravity')!

async function initializeClientInfo(spec: AcpLaunchSpec): Promise<unknown> {
  const rig = await openAcpAdapterRig({
    spec,
    initialize: { authMethods: [{ id: 'oauth-personal', name: 'Google' }] }
  })
  await rig.acquire()
  const { params } = await rig.frame('initialize')
  return (params as { clientInfo?: unknown }).clientInfo
}

it.each([
  ['the pinned managed server', MANAGED, { name: 'zed', version: '0.0.0' }],
  ["the host's agy", MANAGED.hostBackend!.spec, { name: 'orca', version: '1' }],
  ['other agents', GROK, { name: 'orca', version: '1' }]
])('initializes %s with the identity that unlocks its models', async (_label, spec, expected) => {
  expect(await initializeClientInfo(spec)).toEqual(expected)
})
