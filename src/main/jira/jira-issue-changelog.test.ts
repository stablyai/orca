import { describe, expect, it } from 'vitest'
import { changelogTailStart, latestEditorFromChangelog } from './jira-issue-changelog'

const personA = { accountId: 'person-a', displayName: 'Person A' }
const personB = { accountId: 'person-b', displayName: 'Person B' }

describe('latest Jira changelog editor', () => {
  it('uses the last history when the page includes the end', () => {
    const editor = latestEditorFromChangelog({
      startAt: 0,
      total: 2,
      histories: [
        { author: personA, created: '2026-11-01T00:00:00.000Z' },
        { author: personB, created: '2026-11-19T00:00:00.000Z' }
      ]
    })
    expect(editor?.displayName).toBe('Person B')
    expect(
      changelogTailStart({
        startAt: 0,
        total: 2,
        histories: [{ author: personA }, { author: personB }]
      })
    ).toBe(null)
  })

  it('does not treat a short first page as the latest edit', () => {
    const page = {
      startAt: 0,
      total: 5,
      histories: [{ author: personA, created: '2026-10-01T00:00:00.000Z' }]
    }
    expect(latestEditorFromChangelog(page)).toBeUndefined()
    expect(changelogTailStart(page)).toBe(4)
  })

  it('reads the dedicated changelog endpoint shape', () => {
    expect(
      latestEditorFromChangelog({
        startAt: 4,
        total: 5,
        values: [{ author: personB }]
      })?.displayName
    ).toBe('Person B')
  })

  it('returns nothing when history has no named author', () => {
    expect(
      latestEditorFromChangelog({
        startAt: 0,
        total: 1,
        histories: [{ author: { accountId: 'bot' } }]
      })
    ).toBeUndefined()
    expect(latestEditorFromChangelog(undefined)).toBeUndefined()
    expect(changelogTailStart(undefined)).toBeNull()
  })
})
