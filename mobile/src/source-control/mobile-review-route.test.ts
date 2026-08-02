import { describe, expect, it } from 'vitest'
import { firstReviewParam } from '../session/mobile-diff-review-screen-model'
import { buildMobileReviewFileRoute, type MobileReviewRouteArea } from './mobile-review-route'

function queryParams(route: string): URLSearchParams {
  const query = route.split('?')[1] ?? ''
  return new URLSearchParams(query)
}

describe('buildMobileReviewFileRoute', () => {
  it.each(['docs/a&b.md', 'foo#bar.ts', 'path with space.ts', 'src/üñî.ts'])(
    'round-trips file param %s',
    (filePath) => {
      const route = buildMobileReviewFileRoute({
        hostId: 'host/id',
        worktreeId: 'repo::work tree',
        worktreeName: 'My Repo',
        filePath,
        area: 'unstaged'
      })
      const params = queryParams(route)

      expect(route).toContain('/h/host%2Fid/review/repo%3A%3Awork%20tree?')
      expect(firstReviewParam(params.get('file') ?? undefined)).toBe(filePath)
      expect(firstReviewParam(params.get('area') ?? undefined)).toBe('unstaged')
      expect(firstReviewParam(params.get('scope') ?? undefined)).toBe('all')
      expect(firstReviewParam(params.get('name') ?? undefined)).toBe('My Repo')
    }
  )

  it.each<MobileReviewRouteArea>(['unstaged', 'untracked', 'staged', 'branch'])(
    'preserves true area %s',
    (area) => {
      const params = queryParams(
        buildMobileReviewFileRoute({
          hostId: 'host',
          worktreeId: 'wt',
          worktreeName: '',
          filePath: 'a.ts',
          area
        })
      )

      expect(params.get('area')).toBe(area)
    }
  )
})
