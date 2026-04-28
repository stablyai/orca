import { describe, expect, it } from 'vitest'

import { mapGraphQLReactionGroups } from './comment-reactions'

describe('mapGraphQLReactionGroups', () => {
  it('normalizes GraphQL reaction groups into GitHub comment reactions', () => {
    expect(
      mapGraphQLReactionGroups([
        { content: 'EYES', reactors: { totalCount: 1 } },
        { content: 'THUMBS_UP', reactors: { totalCount: 2 } },
        { content: 'HEART', reactors: { totalCount: 0 } },
        { content: 'UNKNOWN', reactors: { totalCount: 9 } }
      ])
    ).toEqual([
      { content: '+1', count: 2 },
      { content: 'eyes', count: 1 }
    ])
  })

  it('returns undefined when there are no visible reactions', () => {
    expect(mapGraphQLReactionGroups([{ content: 'ROCKET', reactors: { totalCount: 0 } }])).toBe(
      undefined
    )
  })
})
