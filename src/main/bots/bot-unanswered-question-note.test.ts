import { describe, expect, it } from 'vitest'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { createBotUnansweredQuestionNote } from './bot-unanswered-question-note'

const OWNER: BotRequestAsker[] = [{ kind: 'owner' }]
const TEAMMATE: BotRequestAsker[] = [
  { kind: 'person', source: 'slack', userId: 'U0SAM', workspaceId: 'T1', role: 'member' }
]

function host(
  records: Record<string, BotRequestAsker[]>,
  looks: { look?: string; tidyUp?: string } = {}
) {
  const ended = new Map<string, number>()
  const getBotConversationActsFor = (sessionId: string) =>
    records[sessionId] ? { actsFor: records[sessionId] } : undefined
  const note = createBotUnansweredQuestionNote({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the note reads only this method.
    getOrchestrationDb: () => ({ getBotConversationActsFor }) as unknown as OrchestrationDb,
    listAutomationRuns: () => [],
    showAutomation: () => {
      throw new Error('gone')
    },
    lookAround: {
      botOfLook: (sessionId) => (sessionId === looks.look ? 'bot-1' : null),
      botOfTidyUp: (sessionId) => (sessionId === looks.tidyUp ? 'bot-1' : null)
    },
    endedTurns: async (sessionId) => ended.get(sessionId) ?? 0
  })
  /** Which of the chat's next `count` turns carry the note, each ending after it. */
  const noted = async (sessionId: string, count: number): Promise<number[]> => {
    const turns: number[] = []
    for (let turn = 1; turn <= count; turn += 1) {
      if (await note(sessionId)) {
        turns.push(turn)
      }
      ended.set(sessionId, turn)
    }
    return turns
  }
  return noted
}

describe('the note on questions the owner left unanswered', () => {
  it('rides every fifth turn of an owner chat', async () => {
    const noted = host({ home: OWNER })
    expect(await noted('home', 12)).toEqual([5, 10])
  })

  it("never rides a teammate's chat, a Look around or Tidy-up run, or an unrecorded chat", async () => {
    const noted = host(
      { 'sam-thread': TEAMMATE, look: OWNER, tidy: OWNER },
      { look: 'look', tidyUp: 'tidy' }
    )
    for (const chat of ['sam-thread', 'look', 'tidy', 'unrecorded']) {
      expect(await noted(chat, 10)).toEqual([])
    }
  })
})
