import { describe, expect, it } from 'vitest'
import { countUnresolvedDiscussions } from './mr-discussion-notes'

describe('countUnresolvedDiscussions', () => {
  it('counts discussions whose root note is unresolved and human-authored', () => {
    expect(
      countUnresolvedDiscussions([
        {
          notes: [
            {
              resolvable: true,
              resolved: false,
              author: { username: 'alice' }
            }
          ]
        },
        {
          notes: [{ resolvable: true, resolved: true, author: { username: 'alice' } }]
        },
        // Why: non-resolvable notes (plain comments) never block review.
        { notes: [{ resolvable: false, author: { username: 'alice' } }] },
        {
          notes: [
            {
              resolvable: true,
              resolved: false,
              author: { username: 'ci', state: 'bot' }
            }
          ]
        },
        {
          notes: [
            { system: true, body: 'changed the description' },
            { resolvable: true, resolved: false, author: { username: 'bob' } }
          ]
        }
      ])
    ).toBe(2)
  })
})
