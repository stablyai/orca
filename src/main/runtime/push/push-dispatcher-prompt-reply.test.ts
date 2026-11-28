import { describe, expect, it, vi } from 'vitest'
import type { PushGatewayClient } from './push-gateway-client'
import { PushDispatcher } from './push-dispatcher'

const reply = { allow: '1', deny: '\u001b' }

describe('PushDispatcher prompt replies', () => {
  it('sends the reply, then once without it when an old gateway rejects the field', async () => {
    const sent: ({ allow: string; deny: string } | undefined)[] = []
    const send = vi.fn(async (body: { notification: { promptReply?: typeof reply } }) => {
      sent.push(body.notification.promptReply)
      if (body.notification.promptReply) {
        return { ok: false as const, reason: 'rejected' as const }
      }
      return {
        ok: true as const,
        results: [{ registrationId: 'reg-1', status: 'queued' as const }]
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: enqueue calls only send, which this stub implements.
    const client = { send } as unknown as PushGatewayClient
    const registration = {
      registrationId: 'reg-1',
      filter: {},
      expiresAt: Date.now() + 60_000
    }
    const dispatcher = new PushDispatcher({
      client,
      registry: {
        // deliver matches the registration object planSend captured, so the list must be stable.
        listDevices: () => [{ deviceId: 'phone', pushRegistration: registration }],
        setPushRegistration: () => true
      }
    })
    dispatcher.enqueue({
      type: 'notification',
      source: 'agent-task-complete',
      agentState: 'blocked',
      title: 'Needs you',
      body: 'Allow?',
      notificationSeq: 1,
      notificationEpoch: 'epoch',
      worktreeId: 'folder:/work',
      paneKey: 'pane',
      promptReply: reply
    })
    await vi.waitFor(() => expect(sent).toEqual([reply, undefined]))
  })
})
