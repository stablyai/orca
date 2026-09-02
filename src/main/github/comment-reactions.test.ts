import { describe, expect, it } from 'vitest'

import { mapGraphQLReactionGroups, toGraphQLReactionContent } from './comment-reactions'

describe('mapGraphQLReactionGroups', () => {
  it('normalizes GraphQL reaction groups into GitHub comment reactions', () => {
    expect(
      mapGraphQLReactionGroups([
        { content: 'EYES', reactors: { totalCount: 1 }, viewerHasReacted: false },
        { content: 'THUMBS_UP', reactors: { totalCount: 2 }, viewerHasReacted: true },
        { content: 'HEART', reactors: { totalCount: 0 } },
        { content: 'UNKNOWN', reactors: { totalCount: 9 } }
      ])
    ).toEqual([
      { content: '+1', count: 2, viewerHasReacted: true },
      { content: 'eyes', count: 1, viewerHasReacted: false }
    ])
  })

  it('returns undefined when there are no visible reactions', () => {
    expect(mapGraphQLReactionGroups([{ content: 'ROCKET', reactors: { totalCount: 0 } }])).toBe(
      undefined
    )
  })

  it('maps REST reaction content to the GraphQL enum', () => {
    expect(toGraphQLReactionContent('+1')).toBe('THUMBS_UP')
    expect(toGraphQLReactionContent('hooray')).toBe('HOORAY')
  })
})
