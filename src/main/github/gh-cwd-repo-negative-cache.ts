import { readLocalGitConfigSignature } from './local-git-config-signature'
import type { GitHubRepoContext } from './github-repository-identity'

/**
 * Negative cache for repos where gh's cwd-based repo resolution fails
 * ("no git remotes found" etc). Orca only falls back to cwd resolution when
 * it could not resolve an owner/repo itself, so for a remote-less repo the
 * failure is deterministic — yet the Tasks page re-spawned gh for every such
 * repo on every refresh (×90 repos in the reported storm). Remember the
 * failure and re-throw it without a subprocess until the repo's git config
 * changes (signature check) or the TTL lapses.
 */
const NEGATIVE_CACHE_TTL_MS = 5 * 60_000
const MAX_ENTRIES = 512

type NegativeCacheEntry = {
  message: string
  configSignature: string | undefined
  expiresAt: number
}

const entries = new Map<string, NegativeCacheEntry>()

function negativeCacheKey(context: GitHubRepoContext): string {
  const runtimeKey = context.connectionId ?? `local:${context.wslDistro ?? 'host'}`
  return `${runtimeKey}\0${context.repoPath}`
}

export function isGhCwdRepoResolutionFailure(text: string): boolean {
  const s = text.toLowerCase()
  return (
    s.includes('no git remotes found') ||
    s.includes('not a git repository') ||
    s.includes('unable to determine base repository') ||
    s.includes('none of the git remotes configured')
  )
}

export async function getRememberedGhCwdResolutionFailure(
  context: GitHubRepoContext
): Promise<string | null> {
  const key = negativeCacheKey(context)
  const entry = entries.get(key)
  if (!entry) {
    return null
  }
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key)
    return null
  }
  // Why: adding a remote is the way out of this failure; the config signature
  // (mtime/size of the repo's git config chain) changes when that happens.
  const signature = await readLocalGitConfigSignature(context)
  if (signature !== entry.configSignature) {
    entries.delete(key)
    return null
  }
  return entry.message
}

export async function rememberGhCwdResolutionFailure(
  context: GitHubRepoContext,
  message: string
): Promise<void> {
  const configSignature = await readLocalGitConfigSignature(context)
  entries.set(negativeCacheKey(context), {
    message,
    configSignature,
    expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS
  })
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next()
    if (oldest.done) {
      break
    }
    entries.delete(oldest.value)
  }
}

/** @internal — test-only */
export function _resetGhCwdRepoNegativeCache(): void {
  entries.clear()
}
