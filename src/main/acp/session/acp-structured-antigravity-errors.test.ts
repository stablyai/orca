import { afterEach, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  openAcpAdapterRig,
  sendHello,
  waitFor
} from './testing/acp-structured-adapter.test-support'

afterEach(closeProviderTimelineRigs)

const quotaError = `Cloud Code Assist API error (429): {
  "error": {
    "code": 429,
    "message": "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h42m11s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "QUOTA_EXHAUSTED",
        "domain": "cloudcode-pa.googleapis.com",
        "metadata": {
          "quotaResetDelay": "3h42m11.598227131s",
          "quotaResetTimeStamp": "2026-11-10T15:58:51Z",
          "uiMessage": "true",
          "model": "claude-opus-5-5-high"
        }
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "13331.598227131s"
      }
    ]
  }
}`

it('publishes the Cloud Code Assist message instead of its JSON envelope in chat', async () => {
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('antigravity')!,
    script: (agent) =>
      agent.on('session/prompt', (frame) =>
        agent.fail(frame, -32603, 'Internal error', { details: quotaError })
      )
  })
  await rig.acquire()
  await sendHello(rig, 'send-1')
  await waitFor(async () =>
    expect((await rig.rig.rows()).filter((row) => row.body.kind === 'status')).toEqual([
      expect.objectContaining({
        body: {
          kind: 'status',
          tone: 'error',
          text: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h42m11s.'
        }
      })
    ])
  )
})
