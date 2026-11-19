import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { keepToBotsOwnEvents } from './bots-composio-events'

function automationWith(where: { path: string; op: '='; values: string[] }[]) {
  const rule = { id: 'r1', source: 'webhook', event: 'call', rev: 1, where }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields the filter reads.
  return { id: 'a1', on: [rule] } as unknown as Automation
}

describe('a Composio hook takes only its bot’s events', () => {
  it('adds the bot’s Composio user to the hook’s filter, once', async () => {
    const updateAutomation = vi.fn(async () => ({}))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the one method it calls.
    const runtime = { updateAutomation } as unknown as OrcaRuntimeService
    const slugOnly = automationWith([
      { path: 'body.metadata.trigger_slug', op: '=', values: ['OUTLOOK_MESSAGE_TRIGGER'] }
    ])
    expect(await keepToBotsOwnEvents(runtime, slugOnly, 'b1')).toBe(
      'where="body.metadata.user_id = orca-bot-b1"'
    )
    expect(updateAutomation).toHaveBeenCalledWith('a1', {
      on: [
        expect.objectContaining({
          where: [
            { path: 'body.metadata.trigger_slug', op: '=', values: ['OUTLOOK_MESSAGE_TRIGGER'] },
            { path: 'body.metadata.user_id', op: '=', values: ['orca-bot-b1'] }
          ]
        })
      ]
    })
    const already = automationWith([
      { path: 'body.metadata.user_id', op: '=', values: ['orca-bot-b1'] }
    ])
    expect(await keepToBotsOwnEvents(runtime, already, 'b1')).toBeUndefined()
    expect(updateAutomation).toHaveBeenCalledTimes(1)
  })
})
