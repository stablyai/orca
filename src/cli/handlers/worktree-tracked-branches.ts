import { addTrackedBranch, normalizeTrackedBranches } from '../../shared/tracked-branches'
import { RuntimeClientError } from '../runtime-client'

/**
 * Builds the tracked-branch list from `--track-branch` / `--clear-branches`.
 *
 * Tracked branches are sibling head branches of the same change (a cherry-pick
 * to a release branch, a stage variant) whose reviews the card should surface
 * next to the worktree's own. They complement `--add-pr`: a branch keeps
 * resolving to whatever PR currently ships from it, while an attached PR is a
 * frozen pointer.
 *
 * `--track-branch` takes a comma-separated list rather than repeating, because
 * the arg parser stores flags in a Map and a repeated flag would silently keep
 * only the last value. Calls are additive; `--clear-branches` drops the list,
 * and combining both replaces it.
 */
export function getTrackedBranchesUpdate(
  flags: Map<string, string | boolean>,
  current: readonly string[] | undefined
): { trackedBranches?: string[] } {
  const clear = flags.get('clear-branches') === true
  const raw = flags.get('track-branch')

  if (raw !== undefined && typeof raw !== 'string') {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --track-branch')
  }

  const incoming = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  if (incoming.length === 0) {
    return clear ? { trackedBranches: [] } : {}
  }

  const invalid = incoming.filter((branch) => normalizeTrackedBranches([branch]).length === 0)
  if (invalid.length > 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Not a usable branch name: ${invalid.join(', ')}`
    )
  }

  let next: string[] = clear ? [] : [...(current ?? [])]
  for (const branch of incoming) {
    next = addTrackedBranch(next, branch)
  }
  return { trackedBranches: next }
}
