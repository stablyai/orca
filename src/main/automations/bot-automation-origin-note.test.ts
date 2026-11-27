import { describe, expect, it } from 'vitest'
import type { AutomationBotTarget } from '../../shared/automation-bot-target'
import { originThreadNote } from './bot-automation-origin-thread'

const ORIGIN = {
  source: 'slack',
  externalId: 'T1:C1:1.2',
  place: '#design',
  sessionId: 's1'
} as const
const SAVED: AutomationBotTarget = {
  botId: 'b1',
  runsIn: 'chat',
  chat: { sessionId: 's1', homeIfGone: true, toConversation: true },
  resultsTo: 'chat',
  originThread: ORIGIN
}

describe('the note on a thread automation that overrode flags', () => {
  it('names only the flags the caller gave', () => {
    const asked: AutomationBotTarget = { botId: 'b1', runsIn: 'new', resultsTo: { channel: 'C1' } }
    expect(originThreadNote(asked, SAVED, { runsIn: true, resultsTo: true })).toContain(
      'this overrode --runs-in and --results-to'
    )
    // An edit of only its results sends the old runs-in back; that is no override.
    expect(originThreadNote(asked, SAVED, { runsIn: false, resultsTo: true })).toContain(
      'this overrode --results-to (--results-to named'
    )
    expect(originThreadNote(asked, SAVED, { runsIn: false, resultsTo: false })).toBeNull()
  })
})
