import { describe, expect, it } from 'vitest'
import { findMobileCommitDetail } from './use-mobile-commit-detail'

describe('findMobileCommitDetail', () => {
  it('names the agent once in the author line, keeps human co-authors in the body, and reads push state', () => {
    const detail = findMobileCommitDetail(
      {
        items: [
          {
            id: 'c2',
            displayId: 'c2c2c2c',
            parentIds: ['c1'],
            subject: 'feat: thing',
            message:
              'feat: thing\n\nWhy it changed.\n\nCo-authored-by: Jane <jane@example.com>\nCo-Authored-By: Claude <noreply@anthropic.com>',
            author: 'Kelvin',
            authorEmail: 'kelvin@example.com',
            timestamp: 1000
          },
          { id: 'c1', parentIds: [], subject: 'base' }
        ],
        currentRef: { id: 'refs/heads/f', name: 'f', revision: 'c2' },
        remoteRef: { id: 'refs/remotes/origin/f', name: 'origin/f', revision: 'c1' },
        mergeBase: 'c1'
      },
      'c2',
      null
    )
    expect(detail).toMatchObject({
      shortId: 'c2c2c2c',
      body: 'Why it changed.\n\nCo-authored-by: Jane <jane@example.com>',
      agent: 'claude',
      agentCoAuthored: true,
      author: 'Kelvin',
      unpushed: true
    })
  })
})
