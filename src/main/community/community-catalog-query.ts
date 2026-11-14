import type { CustomBuildInfo } from '../../shared/custom-build'
import { communityQueryNumber } from '../../shared/community-pr-query'
export { communityQueryNumber } from '../../shared/community-pr-query'
import { classifyCommunityPullRequest } from './community-pr-classification'
import type {
  CommunityCatalog,
  CommunityPullRequest,
  CommunitySyncStatus
} from '../../shared/community-catalog'
import type { CommunityFeaturesSnapshot } from '../../shared/community-features'
import type {
  CommunityPage,
  CommunityQuery,
  CommunitySummary
} from '../../shared/community-operations'

function groups(
  rows: CommunityPullRequest[],
  field: 'area' | 'kind'
): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    counts.set(row[field], (counts.get(row[field]) ?? 0) + 1)
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
}
export function communitySummary(catalog: CommunityCatalog | null): CommunitySummary {
  const rows = (catalog?.pullRequests ?? [])
    .map((pr) => ({ ...pr, ...classifyCommunityPullRequest(pr.title) }))
    .filter((row) => !row.state || row.state === 'open')
  const weeks = new Map<string, number>()
  for (const row of rows) {
    const date = new Date(row.createdAt)
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    const week = date.toISOString().slice(0, 10)
    weeks.set(week, (weeks.get(week) ?? 0) + 1)
  }
  return {
    capturedAt: catalog?.capturedAt ?? null,
    total: rows.length,
    contributors: new Set(rows.map((row) => row.author)).size,
    images: rows.filter((row) => row.imageUrls.length > 0).length,
    drafts: rows.filter((row) => row.isDraft).length,
    areas: groups(rows, 'area'),
    kinds: groups(rows, 'kind'),
    weeks: [...weeks]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }))
  }
}
export function queryCommunityCatalog(
  catalog: CommunityCatalog | null,
  personal: CommunityFeaturesSnapshot,
  status: CommunitySyncStatus,
  query: CommunityQuery,
  viewer: string | null = null,
  build: CustomBuildInfo | null = null
): CommunityPage {
  const number = communityQueryNumber(query.query)
  const words = query.query?.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean) ?? []
  const rows = (catalog?.pullRequests ?? [])
    .map((pr) => ({ ...pr, ...classifyCommunityPullRequest(pr.title) }))
    .filter((row) => {
      const feature = personal.features[row.number]
      const included =
        build?.changes.filter((change) => change.pullRequest?.number === row.number) ?? []
      const open = !row.state || row.state === 'open'
      return (
        (!query.mine || (viewer !== null && row.author.toLowerCase() === viewer.toLowerCase())) &&
        (!query.area || row.area === query.area) &&
        (!query.kind || row.kind === query.kind) &&
        (!query.inclusion ||
          (query.inclusion === 'installed' ? included.length > 0 : !!feature?.selectedAt)) &&
        (!query.readiness ||
          (open && (query.readiness === 'draft' ? row.isDraft : !row.isDraft))) &&
        (!query.images || row.imageUrls.length > 0) &&
        (number !== null
          ? row.number === number
          : words.every((word) =>
              `${row.number} ${row.title} ${row.description ?? ''} ${row.author} ${included.map((change) => `${change.title} ${change.description ?? ''}`).join(' ')}`
                .toLocaleLowerCase()
                .includes(word)
            )) &&
        (!query.view ||
          query.view === 'explore' ||
          (query.view === 'saved'
            ? feature?.savedAt
            : query.view === 'viewed'
              ? feature?.visit
              : feature?.selectedAt))
      )
    })
    .sort((a, b) =>
      query.sort === 'oldest'
        ? a.createdAt.localeCompare(b.createdAt)
        : query.sort === 'popular'
          ? (b.prThumbsUp ?? -1) - (a.prThumbsUp ?? -1) || b.updatedAt.localeCompare(a.updatedAt)
          : b.updatedAt.localeCompare(a.updatedAt)
    )
  const offset = query.offset ?? 0
  const limit = Math.min(60, query.limit ?? 12)
  return {
    filterVersion: 1,
    runningBuild: build,
    viewer,
    mineCount: viewer
      ? (catalog?.pullRequests ?? []).filter(
          (row) => row.author.toLowerCase() === viewer.toLowerCase()
        ).length
      : 0,
    rows: rows.slice(offset, offset + limit),
    total: rows.length,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    summary: communitySummary(catalog),
    status,
    personal
  }
}
