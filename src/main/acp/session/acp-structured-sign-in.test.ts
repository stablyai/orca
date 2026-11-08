import { afterEach, expect, it } from 'vitest'

import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { ACP_LAUNCH_SPECS } from '../launch/acp-launch-registry'
import { openAcpAdapterRig, sendHello } from './testing/acp-structured-adapter.test-support'

afterEach(closeProviderTimelineRigs)

it.each([
  [
    'No API key found for anthropic.\n\nUse /login, set an API key environment variable, or create /host/agent.db',
    'notSignedIn'
  ],
  // OMP says this for an unresolved launch selector as well as when signed out.
  [
    // OMP 18.2.7, recorded from a signed-out temporary home.
    'No model selected.\n\nUse /login, set an API key environment variable, or create /var/folders/25/xk3307ps7552prstq_2qr7080000gn/T/acp-omp-signed-out-y6rh2dq7/.omp/agent/agent.db\n\nThen use /model to select a model.',
    'modelNotSelected'
  ],
  ['No model selected', undefined],
  ['Rate limit exceeded', undefined],
  ['Network connection failed', undefined],
  ['No API key found elsewhere', undefined]
] as const)('reads OMP internal-error detail without guessing auth: %s', async (detail, kind) => {
  const spec = ACP_LAUNCH_SPECS.find((entry) => entry.agent === 'omp')
  if (!spec) {
    throw new Error('OMP launch specification missing')
  }
  const rig = await openAcpAdapterRig({
    spec,
    script: (agent) =>
      agent.on('session/prompt', (frame) =>
        agent.fail(frame, -32603, 'Internal error', { details: detail })
      )
  })
  await rig.acquire()
  await sendHello(rig, 'first')
  await rig.settle()
  const row = (await rig.rig.rows()).find(
    ({ body }) => body.kind === 'status' && body.tone === 'error'
  )
  expect(row?.body.kind === 'status' ? row.body.failure?.kind : undefined).toBe(kind)
})
