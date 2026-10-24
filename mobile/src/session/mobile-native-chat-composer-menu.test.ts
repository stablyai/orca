import { describe, expect, it } from 'vitest'
import {
  draftAfterSkillEdit,
  narrowedMenuItems,
  leadingSkillToken,
  mobileComposerSkillTokens,
  mobileComposerSlashItems
} from './mobile-native-chat-composer-menu'

const reported = [
  { name: 'compact', kind: 'command' as const, description: 'Compact the chat' },
  { name: 'review-pr', kind: 'skill' as const, description: 'Review a pull request' },
  { name: 'research', kind: 'skill' as const }
]

describe('mobileComposerSlashItems', () => {
  it("offers the host's commands, then the session's own and its skills with their descriptions", () => {
    const items = mobileComposerSlashItems({
      agent: 'claude',
      structured: { reported, conversationCommands: ['clear', 'compact'] },
      query: ''
    })
    // The host answers /compact itself, so its row stands in for the session's.
    expect(items.map((item) => [item.kind, item.token, item.description ?? null])).toEqual([
      ['command', '/model', 'Choose the model'],
      ['command', '/effort', 'Choose reasoning effort'],
      ['command', '/clear', 'Clear conversation context'],
      ['command', '/compact', 'Compact conversation context'],
      ['skill', '/research', null],
      ['skill', '/review-pr', 'Review a pull request']
    ])
  })

  it('narrows by the typed query across both groups', () => {
    const items = mobileComposerSlashItems({
      agent: 'claude',
      structured: { reported, conversationCommands: [] },
      query: 'rev'
    })
    expect(items.map((item) => item.token)).toEqual(['/review-pr'])
  })

  it('names skills the way the agent invokes them', () => {
    const items = mobileComposerSlashItems({
      agent: 'codex',
      structured: { reported, conversationCommands: [] },
      query: 'review'
    })
    expect(items.map((item) => item.token)).toEqual(['$review-pr'])
  })

  it('falls back to the host commands, with no skills, before the session reports', () => {
    const items = mobileComposerSlashItems({
      agent: 'claude',
      structured: { reported: undefined, conversationCommands: ['compact'] },
      query: ''
    })
    expect(items.some((item) => item.token === '/compact')).toBe(true)
    expect(items.some((item) => item.kind === 'skill')).toBe(false)
  })

  it('keeps a terminal-backed chat on its curated commands', () => {
    const items = mobileComposerSlashItems({ agent: 'claude', structured: undefined, query: '' })
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.kind === 'command')).toBe(true)
  })
})

describe('mobileComposerSkillTokens', () => {
  it('knows every skill the session loaded, though the menu draws only the first rows', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      name: `skill-${String(index).padStart(2, '0')}`,
      kind: 'skill' as const
    }))
    const structured = { reported: many, conversationCommands: [] }
    const drawn = mobileComposerSlashItems({ agent: 'claude', structured, query: '' })
    expect(drawn.filter((item) => item.kind === 'skill')).toHaveLength(10)
    const tokens = mobileComposerSkillTokens({ agent: 'claude', structured })
    expect(tokens.size).toBe(60)
    expect(tokens.has('/skill-59')).toBe(true)
  })
})

describe('leadingSkillToken', () => {
  const skills = new Set(['/review-pr', '$review-pr'])

  it('reads a known skill followed by a space at the start of the draft', () => {
    expect(leadingSkillToken('/review-pr focus on auth', skills)).toBe('/review-pr')
    expect(leadingSkillToken('/review-pr ', skills)).toBe('/review-pr')
  })

  it('reads nothing until the token is closed, or for a command or prose', () => {
    expect(leadingSkillToken('/review-pr', skills)).toBeNull()
    expect(leadingSkillToken('/compact now', skills)).toBeNull()
    expect(leadingSkillToken(' /review-pr x', skills)).toBeNull()
  })
})

describe('draftAfterSkillEdit', () => {
  it('takes the whole skill out when a delete reaches into it', () => {
    expect(draftAfterSkillEdit('/review-pr ', '/review-pr', '/review-pr')).toBe('')
    expect(draftAfterSkillEdit('/review-pr focus', '/review-prfocus', '/review-pr')).toBe('focus')
    expect(draftAfterSkillEdit('/review-pr focus', '/review-p focus', '/review-pr')).toBe('focus')
  })

  it('keeps every other edit as typed', () => {
    expect(draftAfterSkillEdit('/review-pr focus', '/review-pr focus!', '/review-pr')).toBe(
      '/review-pr focus!'
    )
    expect(draftAfterSkillEdit('/review-pr focus', '/review-pr focu', '/review-pr')).toBe(
      '/review-pr focu'
    )
    expect(draftAfterSkillEdit('/review-pr x', '/review-pXr x', '/review-pr')).toBe('/review-pXr x')
  })
})

describe('narrowedMenuItems', () => {
  const items = mobileComposerSlashItems({
    agent: 'claude',
    structured: { reported, conversationCommands: [] },
    query: ''
  })

  it('keeps one kind when the + sheet asks for it', () => {
    expect(narrowedMenuItems(items, 'skill').every((item) => item.kind === 'skill')).toBe(true)
  })

  it('shows everything when that kind is empty, as for a chat at rest', () => {
    const commandsOnly = items.filter((item) => item.kind === 'command')
    expect(narrowedMenuItems(commandsOnly, 'skill')).toEqual(commandsOnly)
  })
})
