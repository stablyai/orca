import type { CommunityCatalog, CommunityPullRequest } from '../../shared/community-catalog'

export async function refreshCommunityCatalog(args: {
  previous: CommunityCatalog | null
  page: (page: number, mode: 'full' | 'incremental') => Promise<CommunityPullRequest[]>
  signal: AbortSignal
  progress: (pages: number, received: number) => void
  startedAt: string
}): Promise<CommunityCatalog> {
  const { previous, signal } = args
  const fullAt = previous?.lastFullSyncAt ?? previous?.capturedAt
  const mode =
    fullAt && Date.parse(args.startedAt) - Date.parse(fullAt) < 7 * 24 * 60 * 60_000
      ? 'incremental'
      : 'full'
  const rows = new Map(
    mode === 'incremental' ? previous!.pullRequests.map((pr) => [pr.number, pr] as const) : []
  )
  const cutoff =
    mode === 'incremental' && previous ? Date.parse(previous.capturedAt) - 120_000 : null
  let received = 0
  let complete = false
  const visited = new Set<number>()
  for (let page = 1; page <= 200; page++) {
    signal.throwIfAborted()
    const batch = await args.page(page, mode)
    signal.throwIfAborted()
    if (batch.length && batch.every((pr) => visited.has(pr.number))) {
      throw new Error('GitHub pagination repeated a page; saved catalog kept')
    }
    for (const pr of batch) {
      visited.add(pr.number)
      if (pr.state === 'closed' || pr.state === 'merged') {
        rows.delete(pr.number)
      } else {
        rows.set(pr.number, pr)
      }
    }
    received += batch.length
    args.progress(page, received)
    if (
      batch.length < 100 ||
      (cutoff !== null && batch.some((pr) => Date.parse(pr.updatedAt) < cutoff))
    ) {
      complete = true
      break
    }
  }
  if (!complete) {
    throw new Error('GitHub refresh exceeded its page limit; saved catalog kept')
  }
  signal.throwIfAborted()
  const members = new Set(rows.keys())
  return {
    repository: 'stablyai/orca',
    sourceUrl: 'https://github.com/stablyai/orca/pulls',
    capturedAt: args.startedAt,
    lastFullSyncAt: mode === 'full' ? args.startedAt : fullAt,
    source: 'github',
    pullRequests: [...rows.values()],
    screenshots: {},
    groups: (previous?.groups ?? [])
      .map((group) => ({ ...group, members: group.members.filter((n) => members.has(n)) }))
      .filter((group) => group.members.length > 1)
  }
}
