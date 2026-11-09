// "Rebuild?" prompt: compares the active build with each repo's default branch on GitHub. One compare
// call per repo answers both "the branch moved" and "a lockfile changed" (installed deps are stale).
// Uses the GitHub App token when the repo is bound, anonymous otherwise (public repos). Cached briefly
// per isolate so a settings page polling it costs GitHub nothing extra.
import { LOCKFILES, getBuild, parseConfig, parseResult, type BuildDeps } from './environment-builds'
import { parseRepos, type EnvironmentRow } from './environments'
import { parseGitHubRepo } from './github-app'

const CACHE_MS = 60_000
const cache = new Map<string, { at: number; value: Staleness }>()

export type RepoStaleness = {
  url: string
  branch: string | null
  builtCommit: string | null
  headCommit: string | null
  aheadBy: number | null
  lockfilesChanged: string[]
  error: string | null
}

export type Staleness = {
  checkedAt: number
  activeBuildId: string | null
  /** Repos, install script, env names or machine size were edited after the active build. */
  configChanged: boolean
  /** Orca's base image (orcad, agent CLIs) was updated after the active build. */
  imageUpdated: boolean
  /**
   * `deps_changed` (lockfile moved) > `config_changed` > `branch_moved` > `image_updated` > `up_to_date`;
   * `no_build` / `unknown`.
   */
  recommendation: 'no_build' | 'deps_changed' | 'config_changed' | 'branch_moved' | 'image_updated' | 'up_to_date' | 'unknown'
  repos: RepoStaleness[]
}

const LOCKFILE_NAMES = new Set(LOCKFILES)

export async function checkStaleness(
  deps: Pick<BuildDeps, 'db' | 'github' | 'now'> & { githubFetch?: typeof fetch; config?: { goldenSnapshotId: string } },
  environment: EnvironmentRow,
  refresh = false
): Promise<Staleness> {
  const now = deps.now()
  const key = `${environment.id}:${environment.active_build_id ?? ''}:${environment.revision}`
  const hit = cache.get(key)
  if (hit && !refresh && now - hit.at < CACHE_MS) {
    return hit.value
  }
  const build = environment.active_build_id ? await getBuild(deps.db, environment.id, environment.active_build_id) : null
  if (!build) {
    return { checkedAt: now, activeBuildId: null, configChanged: false, imageUpdated: false, recommendation: 'no_build', repos: [] }
  }
  const config = parseConfig(build)
  const result = parseResult(build)
  const configChanged = config.revision !== environment.revision
  const imageUpdated = !!deps.config && build.base_snapshot_id !== deps.config.goldenSnapshotId
  const repos: RepoStaleness[] = []
  for (const repo of parseRepos(environment)) {
    const built = result?.repos?.find((r) => r.url === repo.url)
    const branch = repo.defaultBranch ?? (built?.branch || null)
    const entry: RepoStaleness = {
      url: repo.url,
      branch,
      builtCommit: built?.commit || null,
      headCommit: null,
      aheadBy: null,
      lockfilesChanged: [],
      error: null
    }
    repos.push(entry)
    if (!built?.commit || !/^[0-9a-f]{40}$/.test(built.commit)) {
      entry.error = built ? 'no_commits' : 'not_in_build'
      continue
    }
    try {
      Object.assign(entry, await compare(deps, environment.account_id, repo.url, built.commit, branch ?? 'HEAD'))
    } catch (error) {
      // Anonymous REST calls from shared Worker IPs are often refused (403/429): fall back to git's
      // smart-HTTP ref advertisement plus the lockfiles' raw contents, which need no API quota.
      try {
        Object.assign(entry, await compareAnonymously(deps, repo.url, built.commit, branch, built.lockfiles))
      } catch {
        entry.error = error instanceof Error ? error.message.slice(0, 60) : 'github_unavailable'
      }
    }
  }
  const recommendation: Staleness['recommendation'] = repos.some((r) => r.lockfilesChanged.length > 0)
    ? 'deps_changed'
    : configChanged || repos.some((r) => r.error === 'not_in_build')
      ? 'config_changed'
      : repos.some((r) => (r.aheadBy ?? 0) > 0)
        ? 'branch_moved'
        : repos.some((r) => r.error && r.error !== 'no_commits')
          ? 'unknown'
          : imageUpdated
            ? 'image_updated'
            : 'up_to_date'
  const value: Staleness = { checkedAt: now, activeBuildId: build.id, configChanged, imageUpdated, recommendation, repos }
  cache.set(key, { at: now, value })
  return value
}

async function compare(
  deps: Pick<BuildDeps, 'github'> & { githubFetch?: typeof fetch },
  accountId: string,
  repoUrl: string,
  base: string,
  head: string
): Promise<Pick<RepoStaleness, 'headCommit' | 'aheadBy' | 'lockfilesChanged'>> {
  const parsed = parseGitHubRepo(repoUrl)
  if (!parsed) {
    throw new Error('not_github')
  }
  const token = deps.github ? await deps.github.tokenForRepo(repoUrl, accountId).catch(() => null) : null
  const response = await (deps.githubFetch ?? fetch)(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/compare/${base}...${encodeURIComponent(head)}?per_page=300`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'orca-sandbox-control',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token.token}` } : {})
      }
    }
  )
  if (!response.ok) {
    throw new Error(response.status === 404 ? 'repo_unreachable' : `github_${response.status}`)
  }
  const body = (await response.json()) as {
    ahead_by?: number
    commits?: { sha: string }[]
    files?: { filename: string }[]
  }
  const headCommit = body.commits?.at(-1)?.sha ?? base
  const lockfilesChanged = (body.files ?? [])
    .map((file) => file.filename)
    .filter((name) => LOCKFILE_NAMES.has(name.split('/').at(-1) ?? ''))
  return { headCommit, aheadBy: body.ahead_by ?? 0, lockfilesChanged }
}

async function compareAnonymously(
  deps: { githubFetch?: typeof fetch },
  repoUrl: string,
  base: string,
  branch: string | null,
  lockfiles: Record<string, string>
): Promise<Pick<RepoStaleness, 'headCommit' | 'aheadBy' | 'lockfilesChanged'>> {
  const parsed = parseGitHubRepo(repoUrl)
  if (!parsed) {
    throw new Error('not_github')
  }
  const doFetch = deps.githubFetch ?? fetch
  const refs = await doFetch(`https://github.com/${parsed.owner}/${parsed.repo}.git/info/refs?service=git-upload-pack`, {
    headers: { 'user-agent': 'git/2.45.0 (orca-sandbox-control)' }
  })
  if (!refs.ok) {
    throw new Error(`git_${refs.status}`)
  }
  const text = await refs.text()
  const wanted = branch ? `refs/heads/${branch}` : 'HEAD'
  const head = new RegExp(`([0-9a-f]{40}) ${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\u0000|\\n|$)`).exec(text)?.[1]
  if (!head) {
    throw new Error('branch_missing')
  }
  const lockfilesChanged: string[] = []
  if (head !== base) {
    for (const [path, blob] of Object.entries(lockfiles)) {
      const raw = await doFetch(`https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${head}/${path}`)
      if (raw.status === 404 || (raw.ok && (await gitBlobId(new Uint8Array(await raw.arrayBuffer()))) !== blob)) {
        lockfilesChanged.push(path)
      }
    }
  }
  // Without the API the distance is unknown; 1 means "moved".
  return { headCommit: head, aheadBy: head === base ? 0 : 1, lockfilesChanged }
}

/** git's blob object id: sha1("blob <size>\\0" + content). */
async function gitBlobId(content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${content.length}\u0000`)
  const data = new Uint8Array(header.length + content.length)
  data.set(header)
  data.set(content, header.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', data))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}
