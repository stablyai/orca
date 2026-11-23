import { describe, expect, it } from 'vitest'
import type { WebhookCallRow } from '../../shared/rpc-contract/webhooks-params'
import { checkWebhookCalls, webhookCallText } from './webhook-call-inspection'
import type { WebhookCloudCalls } from './webhook-cloud-routes'

const NOT_FOUND = { ok: false, status: 404, error: 'not_found', retryAfterMs: null } as const
const call = (callId: string, state: 'ignored' | 'queued' | 'started', reason?: string) =>
  ({ kind: 'call', callId, receivedAt: 1, state, ...(reason ? { reason } : {}) }) as const

// The cloud keeps a body only for a call it admitted; an ignored call is a row alone.
function cloud(rows: WebhookCallRow[], bodies: Record<string, string>) {
  const fetched: string[] = []
  const routes = {
    calls: async () => ({ ok: true, value: { calls: rows } }),
    envelope: async (callId: string) => {
      fetched.push(callId)
      const event = bodies[callId]
      return event === undefined
        ? NOT_FOUND
        : {
            ok: true,
            value: {
              receivedAt: 1,
              contentType: 'application/json',
              headers: { 'x-event-key': event },
              body: { kind: 'json', value: {} },
              truncated: false
            }
          }
    }
  } as unknown as WebhookCloudCalls
  return { routes, fetched }
}

describe('reading a hook’s calls', () => {
  it('counts an ignored call as ignored and unknown, without asking for a body it never had', async () => {
    const { routes, fetched } = cloud(
      [call('c1', 'started'), call('c2', 'ignored'), call('c3', 'queued'), call('c4', 'started')],
      { c1: 'pullrequest:created', c3: 'repo:push' }
    )
    const filters = {
      where: [{ path: 'headers.x-event-key', op: '=' as const, values: ['pullrequest:created'] }]
    }
    expect(await checkWebhookCalls(routes, 'wh_x', filters)).toEqual({
      matched: 1,
      unmatched: 1,
      unknown: 2,
      ignored: 1
    })
    expect(fetched).toEqual(['c1', 'c3', 'c4'])
  })

  it('says why an ignored call has no body, with or without a reason from the cloud', async () => {
    const reason = 'Rule rev 3: where="headers.x-event-key = pullrequest:created" didn\'t match'
    const { routes } = cloud([call('c1', 'ignored', reason), call('c2', 'ignored')], {})
    expect(await webhookCallText(routes, 'wh_x', 'c1')).toEqual({
      callId: 'c1',
      ignored: true,
      text: `This call was ignored. ${reason}. Orca keeps no body for an ignored call.`
    })
    expect((await webhookCallText(routes, 'wh_x', 'c2')).text).toBe(
      "This call was ignored by the hook's filters when it came in. Orca keeps no body for an ignored call."
    )
  })

  it('still reports a call that is gone as not found', async () => {
    const { routes } = cloud([call('c1', 'started')], {})
    await expect(webhookCallText(routes, 'wh_x', 'c1')).rejects.toThrow('webhook_not_found')
    await expect(webhookCallText(routes, 'wh_x', 'c9')).rejects.toThrow('webhook_not_found')
  })
})
