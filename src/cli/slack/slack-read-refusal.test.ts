import { describe, expect, it } from 'vitest'

import { callAct } from './slack'

describe('Slack read refusals', () => {
  it('explains an access refusal returned by the action service', async () => {
    const client = {
      call: async () => ({
        ok: true,
        result: { ok: false, refusal: 'missing_scope', message: 'Slack API rejected the request.' }
      })
    } as unknown as Parameters<typeof callAct>[0]

    await expect(
      callAct(client, { sessionId: 'session-1', verb: 'read', args: {} })
    ).rejects.toMatchObject({ message: expect.stringContaining('channels:history') })
  })

  it('keeps a lookup refusal even when its channel name resembles an access error', async () => {
    const client = {
      call: async () => ({
        ok: true,
        result: {
          ok: false,
          refusal: 'ambiguous',
          message: 'Choose one: #slack_missing_scope in Workspace A or Workspace B.'
        }
      })
    } as unknown as Parameters<typeof callAct>[0]

    await expect(
      callAct(client, { sessionId: 'session-1', verb: 'read', args: {} })
    ).rejects.toMatchObject({
      message: 'Choose one: #slack_missing_scope in Workspace A or Workspace B.'
    })
  })
})
