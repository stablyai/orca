import { describe, expect, it } from 'vitest'
import type { BotActingTurn } from './bot-request-asker'
import {
  ASKED_BY_MAX_CHARS,
  askedByLine,
  isSameLinearIssue,
  wakingLinearIssue,
  withAskedBy,
  type BotWriteTurn
} from './bot-owner-writes'

const turn = (overrides: Partial<BotActingTurn> = {}): BotActingTurn => ({
  rootItemId: 'm1',
  askers: [{ kind: 'owner' }],
  askedBy: [{ kind: 'owner' }],
  request: null,
  actingOnRequestId: null,
  requestIds: [],
  wokenAt: null,
  ...overrides
})

const write = (overrides: Partial<BotActingTurn> = {}, inConversation = true): BotWriteTurn => ({
  bot: { name: 'Scout' },
  turn: turn(overrides),
  inConversation
})

const carol = {
  kind: 'person' as const,
  source: 'slack' as const,
  userId: 'U1',
  name: 'Carol',
  workspaceId: 'T1',
  role: 'member' as const
}

describe('a bot write as its owner', () => {
  it('names the Linear issue that woke a run answering there, and only that', () => {
    const woken = { source: 'linear' as const, placeId: 'ENG-42' }
    expect(wakingLinearIssue(write({ wokenAt: woken }))).toBe('ENG-42')
    // The bot's Chat, or a run whose results go elsewhere, answers no issue.
    expect(wakingLinearIssue(write({ wokenAt: woken }, false))).toBeNull()
    expect(
      wakingLinearIssue(write({ wokenAt: { source: 'github', placeId: 'acme/api#1' } }))
    ).toBeNull()
    expect(wakingLinearIssue(null)).toBeNull()
    expect(isSameLinearIssue('eng-42', 'ENG-42')).toBe(true)
    expect(isSameLinearIssue('ENG-42', 'ENG-420')).toBe(false)
  })

  it('tags a comment with who asked when it was not the owner', () => {
    expect(askedByLine(write())).toBeNull()
    expect(askedByLine(write({ askers: [{ kind: 'unknown' }] }))).toBeNull()
    expect(askedByLine(write({ askers: [{ ...carol, role: 'owner' }] }))).toBeNull()
    expect(withAskedBy('Done.\n', write({ askers: [carol] }))).toBe(
      'Done.\n\nasked by Carol via Scout'
    )
    // An automation's event names a person the cloud gave no role to.
    expect(askedByLine(write({ askers: [{ ...carol, role: null, name: undefined }] }))).toBe(
      'asked by U1 via Scout'
    )
    expect(withAskedBy('Done.', null)).toBe('Done.')
    // The bot already ended it so, as its rules say.
    expect(withAskedBy('Done.\n\nAsked by Carol via Scout', write({ askers: [carol] }))).toBe(
      'Done.\n\nAsked by Carol via Scout'
    )
  })

  it('keeps the asked-by line short however many or long the names', () => {
    const people = Array.from({ length: 12 }, (_, i) => ({
      ...carol,
      userId: `U${i}`,
      name: `Person Number ${i}`
    }))
    const many = askedByLine(write({ askers: people })) ?? ''
    expect(many.length).toBeLessThanOrEqual(ASKED_BY_MAX_CHARS)
    expect(many).toMatch(/^asked by Person Number 0, .* and \d+ others via Scout$/)
    const long = askedByLine(write({ askers: [{ ...carol, name: 'x'.repeat(300) }] })) ?? ''
    expect(long.length).toBe(ASKED_BY_MAX_CHARS)
    expect(long).toMatch(/^asked by x+… via Scout$/)
  })
})
