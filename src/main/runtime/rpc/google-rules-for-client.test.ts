import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../shared/automations/automation-definition'
import { automationEditPrecondition } from '../../../shared/automations/automation-edit-precondition'
import { assertBotPlacesUnchanged } from '../../automations/bot-automation-place-refs'
import { automationForClient, unchangedSinceForClient } from './google-rules-for-client'

const stored = {
  id: 'a1',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: 1,
  timezone: 'UTC',
  bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
  on: [
    { id: 'on-pr', source: 'github', event: 'pr_opened', in: [] },
    { id: 'on-mail', source: 'gmail', event: 'new_email', to: ['ops@example.com'] }
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the save guard compares.
} as unknown as Automation

/** A client that does not read Google rules, like the desktop renderer. */
const withoutGoogle = { clientCapabilities: [] }

describe('a guarded save from a client that cannot see Google rules', () => {
  it('compares only the rules that client read', () => {
    const since = automationEditPrecondition(automationForClient(stored, withoutGoogle))
    // Without the restatement the stored Gmail rule reads as a change on every save.
    expect(() => assertBotPlacesUnchanged(stored, since)).toThrow('automation_changed')
    const restated = unchangedSinceForClient(since, () => stored, withoutGoogle)
    expect(() => assertBotPlacesUnchanged(stored, restated)).not.toThrow()
  })

  it('still refuses when a rule it could see changed', () => {
    const since = automationEditPrecondition(automationForClient(stored, withoutGoogle))
    const moved = { ...stored, on: [stored.on![1]!] }
    const restated = unchangedSinceForClient(since, () => moved, withoutGoogle)
    expect(() => assertBotPlacesUnchanged(moved, restated)).toThrow('automation_changed')
  })

  it('leaves a client that reads Google rules, and a save with no guard, as sent', () => {
    const since = automationEditPrecondition(stored)
    const read = (): Automation => {
      throw new Error('not read')
    }
    expect(unchangedSinceForClient(since, read, {})).toBe(since)
    expect(unchangedSinceForClient(undefined, read, withoutGoogle)).toBeUndefined()
  })
})
