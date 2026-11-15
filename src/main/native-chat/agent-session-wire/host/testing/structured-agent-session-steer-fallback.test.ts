import { afterEach, expect, it } from 'vitest'
import { CODEX_STRUCTURED_AGENT } from '../../../../codex/structured/launch/codex-structured-agent-definition'
import { structuredAgentsDeclaringNothing } from '../../providers/testing/structured-agent-session-adapter-router.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  eventually,
  type RigSendOptions
} from './structured-agent-session-queued-message-rig-provider.test-fixture'
import type { AgentSessionSteerFallback } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => rig?.dispose())

const fallbackCases: {
  reason: AgentSessionSteerFallback
  rigOptions: Parameters<typeof createQueuedMessageTestRig>[0]
  sendOptions?: RigSendOptions
}[] = [
  {
    reason: 'provider-queue-only',
    rigOptions: {
      agents: structuredAgentsDeclaringNothing([
        {
          ...CODEX_STRUCTURED_AGENT,
          capabilities: { ...CODEX_STRUCTURED_AGENT.capabilities, steering: 'queue' }
        }
      ])
    }
  },
  { reason: 'codex-options', rigOptions: {}, sendOptions: { carried: { model: 'different' } } },
  { reason: 'codex-legacy', rigOptions: { steeringSupported: false } }
]

it.each(fallbackCases)(
  'publishes $reason fallback, allows cancellation and sends the retained intent after the turn',
  async ({ reason, rigOptions, sendOptions }) => {
    const r = (rig = await createQueuedMessageTestRig(rigOptions))
    const opener = await r.workingSend()
    await openRigTurnFor(r, opener)
    await r.settleAccepted(opener, 'opener')
    const b = r.send('B: check the remote session', 'queue-if-active', sendOptions)
    const c = r.send('C: cancel this', 'queue-if-active', sendOptions)
    expect(await b.result).toMatchObject({ ok: true, value: { queued: { messageId: b.id } } })
    expect(await c.result).toMatchObject({ ok: true, value: { queued: { messageId: c.id } } })
    expect(await r.sendNow(b.id)).toMatchObject({
      ok: true,
      value: { queued: { messageId: b.id } }
    })
    expect(await r.host.history({ sessionId: SESSION, direction: 'tail' })).toMatchObject({
      ok: true,
      page: {
        queuedMessages: expect.arrayContaining([
          {
            messageId: b.id,
            position: expect.any(Number),
            body: expect.any(Object),
            state: 'waiting',
            deliveryMode: 'steer',
            steerFallback: reason
          }
        ])
      }
    })
    expect(await r.handoff(b.id)).toBeUndefined()
    expect(await r.deleteQueued(c.id)).toMatchObject({ ok: true, value: { deleted: true } })
    await openRigTurnFor(r, opener, 'completed', 'success')
    await eventually(async () =>
      expect(await r.handoff(b.id)).toMatchObject({
        queuedMessageId: b.id,
        dispatchState: 'pending',
        handedOverAt: expect.any(Number)
      })
    )
    expect(await r.handoff(c.id)).toBeUndefined()
  }
)
