// Numeric GitHub ids for a repository and its owner, read with the user's own GitHub CLI login.
// GitHub's install page needs both to open with only this repository selected (cloud-start N3); a
// private repository's id isn't readable anonymously, and the control plane never sees a user token.
// Best effort: no gh, not signed in, or slow means the plain install page instead.
import { ghExecFileAsync } from '../git/command-runner/hosted-cli/gh-exec-file'

export type GitHubRepoIds = { repoId: number; ownerId: number }

const LOOKUP_TIMEOUT_MS = 4_000
const cache = new Map<string, Promise<GitHubRepoIds | null>>()

/** `owner/repo` from an https://github.com/<owner>/<repo>[.git] URL; null otherwise. */
export function githubRepoSlug(repoUrl: string): string | null {
  try {
    const url = new URL(repoUrl)
    const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.pathname)
    return url.protocol === 'https:' && url.hostname === 'github.com' && match
      ? `${match[1]}/${match[2]}`
      : null
  } catch {
    return null
  }
}

export function parseGitHubRepoIds(stdout: string): GitHubRepoIds | null {
  const [repoId, ownerId] = stdout.trim().split(/\s+/).map(Number)
  return repoId &&
    ownerId &&
    Number.isSafeInteger(repoId) &&
    Number.isSafeInteger(ownerId) &&
    repoId > 0 &&
    ownerId > 0
    ? { repoId, ownerId }
    : null
}

export function lookupGitHubRepoIds(repoUrl: string): Promise<GitHubRepoIds | null> {
  const slug = githubRepoSlug(repoUrl)
  if (!slug) {
    return Promise.resolve(null)
  }
  const key = slug.toLowerCase()
  let entry = cache.get(key)
  if (!entry) {
    entry = Promise.race([
      ghExecFileAsync(['api', `repos/${slug}`, '--jq', '.id, .owner.id'], {
        host: 'github.com',
        idempotent: true
      }).then(({ stdout }) => parseGitHubRepoIds(stdout)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS))
    ]).catch(() => null)
    const settled = entry
    // Ids never change, so keep hits; forget misses so a later gh sign-in is picked up.
    void settled.then((ids) => {
      if (!ids && cache.get(key) === settled) {
        cache.delete(key)
      }
    })
    cache.set(key, settled)
  }
  return entry
}
