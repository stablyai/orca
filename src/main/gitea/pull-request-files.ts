import { resolveGiteaRepoTarget, type GiteaRepoTarget } from './requests/gitea-repo-target'
import type { GiteaPRFile, GiteaPRFileStatus } from '../../shared/gitea/gitea-types'
import { encodedRepoPath, giteaRepoGet } from './requests/gitea-request'

type RawGiteaPullFile = {
  filename?: string | null
  previous_filename?: string | null
  status?: string | null
  additions?: number
  deletions?: number
}

const PULL_FILE_PAGE_LIMIT = 50
// Up to 1,000 changed files; past that the Files tab says how many of the PR's changed files it shows.
const PULL_FILE_MAX_PAGES = 20

function mapFileStatus(status: string | null | undefined): GiteaPRFileStatus {
  switch (status) {
    case 'added':
    case 'modified':
    case 'deleted':
    case 'renamed':
    case 'copied':
      return status
    case null:
    case undefined:
    default:
      return 'changed'
  }
}

export async function listGiteaPullRequestFiles(
  target: GiteaRepoTarget,
  prNumber: number
): Promise<GiteaPRFile[]> {
  const repo = await resolveGiteaRepoTarget(target)
  if (!repo) {
    return []
  }
  // Gitea caps a page at MAX_RESPONSE_ITEMS (50 by default), so a short page is not the end.
  const raw: RawGiteaPullFile[] = []
  for (let page = 1; page <= PULL_FILE_MAX_PAGES; page += 1) {
    const batch = await giteaRepoGet<RawGiteaPullFile[]>(
      repo,
      `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(prNumber))}/files`,
      { searchParams: { limit: PULL_FILE_PAGE_LIMIT, page } },
      true
    )
    if (!Array.isArray(batch) || batch.length === 0) {
      break
    }
    raw.push(...batch)
  }
  return raw
    .filter((entry): entry is RawGiteaPullFile & { filename: string } => Boolean(entry.filename))
    .map((entry) => ({
      path: entry.filename,
      oldPath: entry.previous_filename?.trim() || undefined,
      status: mapFileStatus(entry.status),
      additions: typeof entry.additions === 'number' ? entry.additions : 0,
      deletions: typeof entry.deletions === 'number' ? entry.deletions : 0
    }))
}
