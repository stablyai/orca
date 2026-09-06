import { describe, expect, it } from 'vitest'
import type { GitHubProjectRow } from './mobile-tasks-view-state-types'
import {
  projectRowIdentityTarget,
  projectRowMutationTarget,
  projectRowSlugTarget
} from './mobile-tasks-project-row-targets'

const HOST = 'github.com'

function row(overrides: Partial<GitHubProjectRow>): GitHubProjectRow {
  return {
    id: 'item-1',
    itemType: 'ISSUE',
    targetId: 'target-1',
    content: { repository: 'orca/orca', number: 42 },
    ...overrides
  } as GitHubProjectRow
}

const DRAFT_ROW = row({
  itemType: 'DRAFT_ISSUE',
  content: {} as GitHubProjectRow['content']
})

describe('project row mutation targets', () => {
  it('keeps the number-addressed target strict', () => {
    expect(projectRowMutationTarget(row({}), HOST)).toEqual({
      owner: 'orca',
      repo: 'orca',
      host: HOST,
      number: 42,
      type: 'issue',
      targetId: 'target-1'
    })
    expect(projectRowMutationTarget(DRAFT_ROW, HOST)).toBeNull()
  })

  // Why: `updateItemField` / `clearItemField` / `resolveReviewThread` address by project item id
  // and thread id; refusing a draft row showed "This project field cannot be edited from mobile."
  // for an edit the host would have accepted.
  it('builds an id-addressed target for a draft row with no slug, number or kind', () => {
    expect(projectRowIdentityTarget(DRAFT_ROW, HOST)).toEqual({
      owner: '',
      repo: '',
      host: HOST,
      number: 0,
      type: 'issue',
      targetId: 'target-1'
    })
  })

  // Why: the `*BySlug` comment edits read the repository and the comment id, nothing else.
  it('builds a slug-addressed target without requiring a number or a kind', () => {
    const numberless = row({
      itemType: 'DRAFT_ISSUE',
      content: { repository: 'orca/orca' } as GitHubProjectRow['content']
    })

    expect(projectRowSlugTarget(numberless, HOST)).toMatchObject({
      owner: 'orca',
      repo: 'orca',
      host: HOST
    })
    expect(projectRowSlugTarget(DRAFT_ROW, HOST)).toBeNull()
  })
})
