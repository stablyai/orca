import { describe, expect, it } from 'vitest'
import { botTurnMemoryReceipt, type BotTurnMemorySnapshot } from './bot-turn-memory-receipt'

const snapshot = (memory: string): BotTurnMemorySnapshot => ({
  memory,
  topics: new Map(),
  version: 0
})

describe('a turn memory receipt', () => {
  it('counts separate additions and removals without inferring a replacement', () => {
    const note = botTurnMemoryReceipt(
      'bot-1',
      snapshot('- Dana prefers calls\n'),
      '- Dana prefers Slack\n',
      new Map()
    )
    expect(note?.botMemoryUpdated).toEqual({
      botId: 'bot-1',
      added: ['Dana prefers Slack'],
      removed: ['Dana prefers calls'],
      topics: [],
      otherChanges: 0
    })
  })

  it('uses generic counts when a non-fact edit cannot be categorized', () => {
    expect(
      botTurnMemoryReceipt('bot-1', snapshot('# Old\n'), '# New\n', new Map())?.botMemoryUpdated
        .otherChanges
    ).toBe(1)
  })

  it('does not report unchanged facts, date/source normalization or empty net changes', () => {
    expect(
      botTurnMemoryReceipt(
        'bot-1',
        snapshot('- 2026-11-01 a fact'),
        '* 2026-11-12 a fact · from: Slack, Dana\n',
        new Map()
      )
    ).toBeNull()
    expect(botTurnMemoryReceipt('bot-1', snapshot(''), '\n', new Map())).toBeNull()
  })

  it('never persists a secret-looking value in a receipt', () => {
    const note = botTurnMemoryReceipt(
      'bot-1',
      snapshot('- password=old-password\n'),
      '- token=new-token\n',
      new Map()
    )
    expect(note?.botMemoryUpdated.added).toEqual(['value hidden'])
    expect(note?.botMemoryUpdated.removed).toEqual(['value hidden'])
    expect(JSON.stringify(note)).not.toContain('new-token')
    expect(JSON.stringify(note)).not.toContain('old-password')
  })
})
