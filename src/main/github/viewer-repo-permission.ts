import type { GitHubViewerRepoPermission, IssueSourcePreference } from '../../shared/types'
import type { LocalGitExecOptions, OwnerRepo } from './gh-utils'
// prettier-ignore
import { ghExecFileAsync, acquire, release, resolveIssueSource, ghRepoExecOptions, githubRepoContext } from './gh-utils'

// Why: segments are interpolated into gh API paths — reject `.`/`..` so a
// crafted slug cannot resolve to a different route.
const VALID_SLUG_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/

/**
 * Highest permission the viewer holds on the repo that issue mutations for
 * `repoPath` would target (or the explicit owner/repo override). Resolution
 * mirrors `updateIssue` so the answer describes the repo the write would hit.
 * Returns null on any failure — callers fail open and keep their controls.
 */
export async function getViewerRepoPermission(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  overrideOwnerRepo?: OwnerRepo | null
): Promise<{ permission: GitHubViewerRepoPermission; source: OwnerRepo } | null> {
  const ownerRepo =
    overrideOwnerRepo ??
    (await resolveIssueSource(repoPath, preference, connectionId, localGitOptions)).source
  if (
    !ownerRepo ||
    !VALID_SLUG_SEGMENT.test(ownerRepo.owner) ||
    !VALID_SLUG_SEGMENT.test(ownerRepo.repo)
  ) {
    return null
  }
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      ['api', '--cache', '300s', `repos/${ownerRepo.owner}/${ownerRepo.repo}`],
      ghOptions
    )
    const data = JSON.parse(stdout) as {
      permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean }
    }
    const flags = data.permissions
    // Why: `permissions` is absent in some auth contexts (e.g. app tokens).
    // That's an unknown, not read-only — treat it like a failed probe so
    // callers fail open instead of hiding write controls.
    if (!flags) {
      return null
    }
    const permission: GitHubViewerRepoPermission = flags.admin
      ? 'admin'
      : flags.maintain
        ? 'maintain'
        : flags.push
          ? 'write'
          : flags.triage
            ? 'triage'
            : 'read'
    return { permission, source: ownerRepo }
  } catch {
    return null
  } finally {
    release()
  }
}
