// Name the commits in a push that changed each failing file, and the merged PR behind each commit.
// Attribution is optional: one bounded pass that stops at the first API failure.
import { EMPTY_TREE_SHA } from './main-push-range.mjs'

export const ATTRIBUTION_LIMITS = {
  budgetMs: 60_000,
  requestTimeoutMs: 10_000,
  maxRequests: 40,
  maxFiles: 20
}

export function createGithubApi(env, limits = ATTRIBUTION_LIMITS, fetchImpl = fetch) {
  const deadline = AbortSignal.timeout(limits.budgetMs)
  const token = env.GH_TOKEN || env.GITHUB_TOKEN
  let requests = 0
  let failure = null
  async function api(path) {
    if (!failure && deadline.aborted) {
      failure = `the ${limits.budgetMs / 1000}s attribution budget is spent`
    }
    if (!failure && requests >= limits.maxRequests) {
      failure = `the ${limits.maxRequests}-request attribution cap is reached`
    }
    if (failure) {
      throw new Error(failure)
    }
    requests += 1
    try {
      const response = await fetchImpl(
        `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/${path}`,
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          },
          signal: AbortSignal.any([AbortSignal.timeout(limits.requestTimeoutMs), deadline])
        }
      )
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      // A rate limit or outage would only repeat, so the first failure ends every later lookup.
      failure = `GitHub API request failed (${error.message})`
      throw new Error(failure)
    }
  }
  api.requestCount = () => requests
  return api
}

export function pullNumberFromSubject(subject) {
  const match = /\(#(\d+)\)\s*$/.exec(subject ?? '')
  return match ? Number(match[1]) : null
}

// One page of results; a full page may have more behind it.
const MAX_PAGE = 100

// Only a merged PR into this repo and branch counts; open or other-base associations are not evidence.
// A full page of associations may hide more, so it cannot show that a PR is the only one, or that none exists.
export function choosePull(pulls, { repo, ref }) {
  if (pulls.length >= MAX_PAGE) {
    return { status: 'partial' }
  }
  const merged = pulls.filter(
    (pull) => pull.merged_at && pull.base?.ref === ref && pull.base?.repo?.full_name === repo
  )
  if (merged.length === 1) {
    return { status: 'merged', number: merged[0].number, author: merged[0].user?.login ?? null }
  }
  if (merged.length > 1) {
    return { status: 'ambiguous', numbers: merged.map((pull) => pull.number) }
  }
  return { status: 'none' }
}

export async function attributeFiles(
  files,
  { base, head, repo, ref, api, maxFiles = ATTRIBUTION_LIMITS.maxFiles }
) {
  const results = new Map()
  // Nothing to look up costs no request.
  if (files.length === 0) {
    return results
  }
  const markAll = (reason) => {
    for (const file of files) {
      results.set(file, { status: 'unavailable', reason })
    }
    return results
  }
  if (base === EMPTY_TREE_SHA) {
    return markAll('this run has no earlier push tip to compare against')
  }
  let pushShas
  try {
    const comparison = await api(`compare/${base}...${head}`)
    if (comparison.total_commits > comparison.commits.length) {
      return markAll('the push has more commits than GitHub lists')
    }
    pushShas = new Set(comparison.commits.map((commit) => commit.sha))
  } catch (error) {
    return markAll(error.message)
  }
  const commitsBySha = new Map()
  const describeCommit = (commit) => {
    if (!commitsBySha.has(commit.sha)) {
      commitsBySha.set(commit.sha, lookupCommit(commit, { repo, ref, api }))
    }
    return commitsBySha.get(commit.sha)
  }
  for (const [index, file] of files.entries()) {
    if (index >= maxFiles) {
      results.set(file, {
        status: 'unavailable',
        reason: `only the first ${maxFiles} looked-up paths are attributed`
      })
      continue
    }
    if (pushShas.size === 0) {
      results.set(file, { status: 'found', commits: [] })
      continue
    }
    try {
      // Main is linear, so the push's commits to this file are the newest entries in its history. Asking for one
      // more than the push holds shows where they end; a full page of push commits may have more behind it.
      const perPage = Math.min(MAX_PAGE, pushShas.size + 1)
      const history = await api(
        `commits?sha=${head}&path=${encodeURIComponent(file)}&per_page=${perPage}`
      )
      const inPush = history.filter((entry) => pushShas.has(entry.sha))
      const commits = []
      for (const commit of inPush) {
        commits.push(await describeCommit(commit))
      }
      const partial = history.length >= perPage && inPush.length === history.length
      results.set(file, { status: 'found', commits, partial })
    } catch (error) {
      results.set(file, { status: 'unavailable', reason: error.message })
    }
  }
  return results
}

async function lookupCommit(commit, { repo, ref, api }) {
  const author = commit.author?.login ?? null
  try {
    return {
      sha: commit.sha,
      author,
      pull: choosePull(await api(`commits/${commit.sha}/pulls?per_page=${MAX_PAGE}`), { repo, ref })
    }
  } catch {
    const subjectHint = pullNumberFromSubject(commit.commit?.message?.split('\n')[0])
    return { sha: commit.sha, author, pull: { status: 'unavailable', subjectHint } }
  }
}

function describeCommit({ sha, author, pull }, ref) {
  const commit = sha.slice(0, 10)
  const by = author ? ` by @${author}` : ''
  switch (pull.status) {
    case 'merged':
      return `#${pull.number}${pull.author ? ` by @${pull.author}` : by} (${commit})`
    case 'ambiguous':
      return `commit ${commit}${by} (several merged PRs: ${pull.numbers.map((number) => `#${number}`).join(', ')})`
    case 'none':
      return `commit ${commit}${by} (no merged PR into ${ref})`
    case 'partial':
      return `commit ${commit}${by} (PR lookup incomplete: ${MAX_PAGE} or more associated PRs)`
    default:
      return `commit ${commit}${by} (PR lookup unavailable${pull.subjectHint ? `; its subject cites #${pull.subjectHint}, unverified` : ''})`
  }
}

// At most this many characters, commit first, for a policy input in a tight explanation.
export const MAX_COMPACT_CHARS = 70
const PR_NOTE = {
  ambiguous: ' (several PRs)',
  none: ' (no merged PR)',
  partial: ' (PR lookup incomplete)'
}

// A short form for a policy input that never loses its first commit's SHA: "c60247760f #7", "+2 more commit(s)",
// or why the lookup failed.
export function compactAttribution(entry) {
  if (!entry || entry.status === 'unavailable') {
    const reason = entry?.reason ?? 'not looked up'
    return `lookup unavailable: ${reason.length > 50 ? `${reason.slice(0, 49)}…` : reason}`
  }
  if (entry.commits.length === 0) {
    return 'no commit in this push changed it'
  }
  const [{ sha, pull }] = entry.commits
  const pr =
    pull.status === 'merged'
      ? ` #${pull.number}`
      : (PR_NOTE[pull.status] ?? ' (PR lookup unavailable)')
  const more =
    entry.commits.length > 1
      ? `, +${entry.commits.length - 1}${entry.partial ? ' or more' : ''} more commit(s)`
      : entry.partial
        ? ', possibly more commits'
        : ''
  return `${sha.slice(0, 10)}${pr}${more}`.slice(0, MAX_COMPACT_CHARS)
}

// Plain text; callers escape it for Markdown or the log.
export function describeAttribution(entry, ref) {
  if (!entry || entry.status === 'unavailable') {
    return `unknown (${entry?.reason ?? 'not looked up'})`
  }
  if (entry.commits.length === 0) {
    return 'no commit added by this push changed it'
  }
  const commits = entry.commits.map((commit) => describeCommit(commit, ref))
  if (entry.partial) {
    return `at least ${commits.length} commits, listing stopped at one page of ${MAX_PAGE}: ${commits.join('; ')}`
  }
  return commits.length === 1 ? commits[0] : `${commits.length} commits: ${commits.join('; ')}`
}
