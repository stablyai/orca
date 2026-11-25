import { expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../structured-agent-session-registry'
import { STRUCTURED_AGENT_SESSION_ACK_PROVIDER_RECEIPTS as ack } from '../../../../runtime/rpc/methods/structured-sessions/subscriptions/structured-agent-session-provider-receipt-acks'
import { STRUCTURED_AGENT_SESSION_SUBSCRIBE_METHOD as subscribe } from '../../../../runtime/rpc/methods/structured-sessions/subscriptions/structured-agent-session-subscribe-method'
import type { RpcContext } from '../../../../runtime/rpc/core'
import type { AgentSessionProviderReceiptFrame } from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY
} from '../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from '../../../../../shared/agent-session/requests/agent-session-current-requests-capability'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import { claudeReceiptIngress } from './structured-agent-session-provider-receipt-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION as CHAT,
  HOST_TEST_NOW as NOW
} from './structured-agent-session-host-test-data.test-fixture'

it.each(['runtime', 'mobile'] as const)(
  'uses a one-frame receipt window without changing the ordinary %s transcript',
  async (clientKind) => {
    const rig = await createQueuedMessageTestRig({ agent: 'claude' })
    const signals = [new AbortController(), new AbortController(), new AbortController()]
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    setStructuredAgentSessionHost(rig.host)
    try {
      const id = await rig.workingSend()
      await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
      const ingress = claudeReceiptIngress(rig)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installed host is real; the transport fixture owns only stream cleanup.
      const runtime = {
        registerOwnedSubscriptionCleanup: (_id: string, close: () => void) => ({
          releaseIfCurrent: close
        })
      } as RpcContext['runtime']
      const frames: unknown[][] = [[], [], []]
      const context = (index: number): RpcContext => ({
        runtime,
        clientKind,
        clientCapabilities: [
          STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
          ...(index
            ? [
                AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY,
                AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY
              ]
            : [])
        ],
        requestId: `stream-${index}`,
        connectionId: 'same-connection',
        signal: signals[index]!.signal
      })
      for (let index = 0; index < frames.length; index++) {
        await subscribe.handler(
          {
            sessionId: CHAT,
            ...(index === 2 ? { capabilities: { providerReceipts: 1 } } : {})
          },
          context(index),
          (frame) => void frames[index]!.push(frame)
        )
      }
      const receiptFrames = (): AgentSessionProviderReceiptFrame[] =>
        frames[2]!.filter(
          (frame): frame is AgentSessionProviderReceiptFrame =>
            typeof frame === 'object' &&
            frame !== null &&
            'type' in frame &&
            frame.type === 'provider-receipts'
        )
      await eventually(() => expect(receiptFrames()).toHaveLength(1))
      const first = receiptFrames()[0]!
      expect(first).toMatchObject({ replace: true, updates: [] })
      const acknowledgement = { subscription: first.subscription, revision: first.revision }

      ingress.lifecycle('queued', NOW + 100)
      await ack.handler(acknowledgement, { ...context(2), connectionId: 'other-connection' })
      await ack.handler({ ...acknowledgement, revision: acknowledgement.revision + 1 }, context(2))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(receiptFrames()).toHaveLength(1)
      await ack.handler(acknowledgement, context(2))
      await eventually(() =>
        expect(receiptFrames()[1]?.updates).toEqual([
          { clientMessageId: id, observedAt: NOW + 100 }
        ])
      )
      const atOpen = frames.slice(0, 2).map((events) => events.length)

      ingress.echo()
      ingress.assistant()
      expect(await ingress.flush()).toEqual({ ok: true })
      await eventually(() => {
        expect(JSON.stringify(frames[0])).toContain('Hello there')
        expect(JSON.stringify(frames[1])).toContain('Hello there')
      })
      expect(receiptFrames()).toHaveLength(2)
      expect(frames.slice(0, 2).every((events, index) => events.length > atOpen[index]!)).toBe(true)
      for (const normal of frames.slice(0, 2)) {
        expect(JSON.stringify(normal)).not.toContain('provider-receipts')
      }
      await eventually(() =>
        expect(
          JSON.stringify(
            frames[2]!.filter((frame) => !receiptFrames().some((receipt) => frame === receipt))
          )
        ).toBe(JSON.stringify(frames[1]))
      )
      const second = receiptFrames()[1]!
      await ack.handler(
        { subscription: second.subscription, revision: second.revision },
        context(2)
      )
      await eventually(() => {
        const last = receiptFrames()[2]
        expect(last?.revision).toBeGreaterThan(second.revision)
        expect(last?.updates).toEqual(
          last?.replace ? [] : [{ clientMessageId: id, observedAt: null }]
        )
      })
    } finally {
      for (const signal of signals) {
        signal.abort()
      }
      clock.mockRestore()
      setStructuredAgentSessionHost(null)
      await rig.dispose()
    }
  }
)
