// GitHub's installation lookups for repo-access, cached in D1 so every isolate shares
// them and the create wizard's 2 s poll doesn't spend an app-JWT call each time. A found installation
// is kept a minute, a 404 for 15 s. The installation webhooks and the setup return drop the owner's
// entries (forgetOwner/forgetInstallation), so an install is seen on the next poll, not after the TTL.
// Only ids and the owner's login are stored. Any D1 failure falls through to GitHub.
import type { GitHubAppMinter, GitHubInstallation } from './github-app'

export const FOUND_TTL_MS = 60_000
export const MISSING_TTL_MS = 15_000

type Row = {
  installation_id: number | null
  github_account_id: number | null
  github_account_login: string | null
  github_account_type: string | null
  checked_at: number
}

function fromRow(row: Row): GitHubInstallation | null {
  if (row.installation_id === null || row.github_account_login === null) {
    return null
  }
  return {
    id: row.installation_id,
    account: {
      id: row.github_account_id ?? 0,
      login: row.github_account_login,
      type: row.github_account_type === 'User' ? 'User' : 'Organization'
    }
  }
}

async function cached(
  db: D1Database,
  key: string,
  ownerKey: string,
  now: number,
  lookup: () => Promise<GitHubInstallation | null>
): Promise<GitHubInstallation | null> {
  const row = await db
    .prepare(
      'SELECT installation_id, github_account_id, github_account_login, github_account_type, checked_at FROM github_installation_cache WHERE cache_key = ?'
    )
    .bind(key)
    .first<Row>()
    .catch(() => null)
  if (row && now - row.checked_at < (row.installation_id === null ? MISSING_TTL_MS : FOUND_TTL_MS)) {
    return fromRow(row)
  }
  // GitHub errors propagate uncached (repo-access answers 502; the next poll asks again).
  const found = await lookup()
  await db
    .prepare(
      `INSERT INTO github_installation_cache (cache_key, owner_key, installation_id, github_account_id, github_account_login, github_account_type, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (cache_key) DO UPDATE SET installation_id = excluded.installation_id, github_account_id = excluded.github_account_id,
         github_account_login = excluded.github_account_login, github_account_type = excluded.github_account_type, checked_at = excluded.checked_at`
    )
    .bind(key, ownerKey, found?.id ?? null, found?.account.id ?? null, found?.account.login ?? null, found?.account.type ?? null, now)
    .run()
    .catch(() => undefined)
  return found
}

/** GET /repos/{owner}/{repo}/installation, cached. */
export function cachedRepoInstallation(
  db: D1Database,
  github: GitHubAppMinter,
  parsed: { owner: string; repo: string },
  now: number
): Promise<GitHubInstallation | null> {
  const owner = parsed.owner.toLowerCase()
  return cached(db, `${owner}/${parsed.repo.toLowerCase()}`, owner, now, () =>
    github.getRepoInstallation(`https://github.com/${parsed.owner}/${parsed.repo}`)
  )
}

/** The App's installation on the owner (org or user), cached; null when the minter can't ask. */
export function cachedOwnerInstallation(
  db: D1Database,
  github: GitHubAppMinter,
  owner: string,
  now: number
): Promise<GitHubInstallation | null> {
  const lookup = github.getOwnerInstallation
  if (!lookup) {
    return Promise.resolve(null)
  }
  const key = owner.toLowerCase()
  return cached(db, `${key}/`, key, now, () => lookup.call(github, owner))
}

/** An install, uninstall, or repository selection change on this owner: ask GitHub next time. */
export async function forgetOwner(db: D1Database, owner: string): Promise<void> {
  await db
    .prepare('DELETE FROM github_installation_cache WHERE owner_key = ?')
    .bind(owner.toLowerCase())
    .run()
    .catch(() => undefined)
}

/** Same, by installation id (a webhook whose account login is missing). */
export async function forgetInstallation(db: D1Database, installationId: number): Promise<void> {
  await db
    .prepare('DELETE FROM github_installation_cache WHERE installation_id = ?')
    .bind(installationId)
    .run()
    .catch(() => undefined)
}
