import { describe, expect, it } from 'vitest'

import { buildMobileReviewFileRoute } from './mobile-review-route'

function queryParams(route: string): URLSearchParams {
  const query = route.split('?')[1] ?? ''
  return new URLSearchParams(query)
}

describe('buildMobileReviewFileRoute', () => {
  it('carries the commit for a file opened from a commit', () => {
    const params = queryParams(
      buildMobileReviewFileRoute({
        hostId: 'host',
        worktreeId: 'wt',
        worktreeName: '',
        filePath: 'a.ts',
        area: 'commit',
        commitOid: 'c0ffee0123456789abcdef0123456789abcdef01'
      })
    )

    expect(params.get('area')).toBe('commit')
    expect(params.get('commit')).toBe('c0ffee0123456789abcdef0123456789abcdef01')
  })
})
