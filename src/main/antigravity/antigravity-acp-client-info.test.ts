import { afterEach, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import { GROK, openAcpAdapterRig } from '../acp/session/testing/acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const MANAGED = acpLaunchSpecFor('antigravity')!

async function initializeClientInfo(spec: AcpLaunchSpec, version?: string): Promise<unknown> {
  const rig = await openAcpAdapterRig({
    spec,
    ...(version ? { launch: { version } } : {}),
    initialize: { authMethods: [{ id: 'oauth-personal', name: 'Google' }] }
  })
  await rig.acquire()
  const { params } = await rig.frame('initialize')
  return (params as { clientInfo?: unknown }).clientInfo
}

const ZED = { name: 'zed', version: '0.0.0' }
const ORCA = { name: 'orca', version: '1' }
const HOST = MANAGED.hostBackend!.spec

it.each([
  ['the pinned managed server', MANAGED, undefined, ZED],
  ["the host's agy 1.5.2", HOST, '1.5.2', ORCA],
  ["the host's agy of unknown version", HOST, undefined, ZED],
  ['other agents', GROK, undefined, ORCA]
])(
  'initializes %s with the identity that unlocks its models',
  async (_label, spec, version, expected) => {
    expect(await initializeClientInfo(spec, version)).toEqual(expected)
  }
)
