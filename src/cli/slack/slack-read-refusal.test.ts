import { describe, expect, it } from 'vitest'

import { callAct } from './slack'

describe('Slack read refusals', () => {
  it('explains an access refusal returned by the action service', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callAct reads only call in this refusal test.
    const client = {
      call: async () => ({
        ok: true,
        result: {
          ok: false,
          refusal: 'refused',
          reason: 'slack_history_scope_missing',
          scope: 'channels:history',
          message: 'Slack API rejected the request.'
        }
      })
    } as unknown as Parameters<typeof callAct>[0]

    await expect(
      callAct(client, { sessionId: 'session-1', verb: 'read', args: {} })
    ).rejects.toMatchObject({ message: expect.stringContaining('channels:history') })
  })

  it('keeps a lookup refusal even when its channel name resembles an access error', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callAct reads only call in this refusal test.
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

  it('keeps generic service recovery text unchanged', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callAct reads only call in this refusal test.
    const client = {
      call: async () => ({
        ok: true,
        result: {
          ok: false,
          refusal: 'needs_reapproval',
          message: 'Update the bot from this link, then try again.'
        }
      })
    } as unknown as Parameters<typeof callAct>[0]

    await expect(
      callAct(client, { sessionId: 'session-1', verb: 'read', args: {} })
    ).rejects.toMatchObject({ message: 'Update the bot from this link, then try again.' })
  })
})
