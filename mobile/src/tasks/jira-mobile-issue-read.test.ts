import { describe, expect, it } from 'vitest'
import { toJiraDetailComments } from './jira-mobile-issue-read'

describe('toJiraDetailComments', () => {
  it('maps the author and avatar off the nested user', () => {
    expect(
      toJiraDetailComments([
        {
          id: '10',
          body: 'hi',
          createdAt: '2026-01-01T00:00:00Z',
          user: { accountId: 'a', displayName: 'Dana', avatarUrl: 'https://x/y.png' }
        }
      ])
    ).toEqual([
      {
        id: '10',
        author: 'Dana',
        authorAvatarUrl: 'https://x/y.png',
        body: 'hi',
        createdAt: '2026-01-01T00:00:00Z'
      }
    ])
  })

  it('degrades to an empty list instead of breaking the detail sheet', () => {
    expect(toJiraDetailComments(null)).toEqual([])
    expect(toJiraDetailComments({ error: 'nope' })).toEqual([])
  })

  it('drops entries without a usable id', () => {
    expect(
      toJiraDetailComments([{ id: 5, body: 'x' }, { body: 'y' }, { id: '7', body: 'z' }])
    ).toEqual([
      { id: '7', author: undefined, authorAvatarUrl: undefined, body: 'z', createdAt: undefined }
    ])
  })
})
