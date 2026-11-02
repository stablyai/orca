import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKTREE_CARD_PROPERTIES,
  getWorktreeCardDetails
} from '../../../src/shared/worktree/card-properties'
import type { Worktree } from './workspace-list-types'
import { getWorktreeMetaGlyphPresence } from './worktree-meta-glyph-presence'

const ALL = getWorktreeCardDetails(DEFAULT_WORKTREE_CARD_PROPERTIES, {
  compactWorktreeCards: false,
  newCardStyle: false
})

const row: Worktree = {
  worktreeId: 'w',
  repoId: 'r',
  repo: 'orca',
  path: '/w',
  branch: 'b',
  displayName: 'w',
  liveTerminalCount: 0,
  hasAttachedPty: false,
  unread: false,
  isPinned: false,
  linkedPR: null
}

describe('getWorktreeMetaGlyphPresence', () => {
  it('shows each fact the row carries and its property turns on', () => {
    expect(
      getWorktreeMetaGlyphPresence(
        {
          ...row,
          comment: ' note ',
          automationCreated: true,
          cliCreated: true,
          linkedIssue: 3,
          linkedLinearIssue: 'ENG-1',
          linkedGitLabMR: 4,
          linkedItems: [{ provider: 'jira', type: 'issue', number: 1 }]
        },
        ALL
      )
    ).toEqual({
      notes: true,
      automation: true,
      cli: true,
      issue: true,
      jira: true,
      linear: true,
      gitLabMR: true
    })
  })

  it('shows none for a bare row, or when the properties are off', () => {
    const none = getWorktreeCardDetails([], { compactWorktreeCards: false, newCardStyle: false })
    expect(Object.values(getWorktreeMetaGlyphPresence(row, ALL)).some(Boolean)).toBe(false)
    expect(
      Object.values(
        getWorktreeMetaGlyphPresence({ ...row, automationCreated: true, cliCreated: true }, none)
      ).some(Boolean)
    ).toBe(false)
  })

  it('finds only a linked Jira issue, and reads an unchecked list without throwing', () => {
    const jiraFor = (linkedItems: unknown) =>
      getWorktreeMetaGlyphPresence(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rows reach the phone unchecked; this feeds the malformed shapes a host could send.
        { ...row, linkedItems } as Worktree,
        ALL
      ).jira
    expect(jiraFor([{ provider: 'linear', type: 'issue', number: 1 }])).toBe(false)
    expect(jiraFor([{ provider: 'jira', type: 'pr', number: 1 }])).toBe(false)
    expect(jiraFor('jira')).toBe(false)
    expect(jiraFor([null, 3])).toBe(false)
  })
})
