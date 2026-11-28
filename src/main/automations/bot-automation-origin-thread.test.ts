import { describe, expect, it } from 'vitest'
import type { AutomationBotTarget } from '../../shared/automation-bot-target'
import { originThreadNote } from './bot-automation-origin-thread'

const ORIGIN = {
  source: 'slack',
  externalId: 'T1:C1:1.2',
  place: '#design',
  sessionId: 's1'
} as const
const IN_THREAD: AutomationBotTarget = {
  botId: 'b1',
  runsIn: 'chat',
  chat: { sessionId: 's1', homeIfGone: true, toConversation: true },
  resultsTo: 'chat',
  originThread: ORIGIN
}

describe('the note on a thread automation', () => {
  it('names only the flags the caller gave', () => {
    const asked: AutomationBotTarget = { botId: 'b1', runsIn: 'new', resultsTo: { channel: 'C1' } }
    expect(originThreadNote(asked, IN_THREAD, { runsIn: true, resultsTo: false })).toBe(
      'Made while answering the Slack thread in #design, so it runs in this chat and replies there: this overrode --runs-in. To post in a different channel instead, name that channel with --results-to channel:<channel>.'
    )
    expect(originThreadNote(asked, IN_THREAD, { runsIn: false, resultsTo: false })).toBeNull()
  })

  it('names an explicit --results-to chat that now answers the thread', () => {
    const asked: AutomationBotTarget = { botId: 'b1', runsIn: 'new', resultsTo: 'chat' }
    expect(originThreadNote(asked, IN_THREAD, { runsIn: false, resultsTo: true })).toContain(
      'this overrode --results-to.'
    )
  })

  it('says why one on its own agent keeps its results in Orca', () => {
    const saved: AutomationBotTarget = {
      botId: 'b1',
      runsIn: 'new',
      agentSetup: { agent: 'codex' },
      resultsTo: 'chat',
      originThread: ORIGIN
    }
    const asked = { ...saved, resultsTo: { channel: 'C1' } }
    expect(originThreadNote(asked, saved, { runsIn: false, resultsTo: true })).toBe(
      'Made while answering the Slack thread in #design, but it runs on its own agent, so its results stay in Orca instead of posting beside that thread. To answer there, leave out --agent.'
    )
  })
})
