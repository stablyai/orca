/**
 * A folder workspace holds N independent git repos. Operations that carry no path
 * — commit, merge/rebase abort — have nothing to route on, so the owning repo has
 * to be inferred from repository state instead.
 *
 * Git has no cross-repo transaction: fanning one click out to N repos can leave
 * repos 1..k committed when k+1 fails, and neither the `{ success, error? }` nor
 * the `{ ok: true }` result contract can describe that. So these pick exactly one
 * target and reject ambiguity *before* anything is mutated.
 */
export type FolderWorkspaceOperationTarget<T> =
  | { ok: true; target: T }
  | { ok: false; error: string }

export type FolderWorkspaceChildCandidate<T> =
  | { repoName: string; target: T; selected: boolean }
  | { repoName: string; error: string }

type UninspectableChild = { repoName: string; error: string }

function isUninspectable<T>(
  candidate: FolderWorkspaceChildCandidate<T>
): candidate is UninspectableChild {
  return 'error' in candidate
}

function selectExactlyOne<T>(
  candidates: readonly FolderWorkspaceChildCandidate<T>[],
  messages: { none: string; many: (repoNames: string[]) => string }
): FolderWorkspaceOperationTarget<T> {
  const unreadable = candidates.filter(isUninspectable)
  if (unreadable.length > 0) {
    // Why: fail closed. An unreadable repo could be the one holding the staged
    // changes or the active merge; acting on the others would silently skip it
    // and report success for work that never happened.
    return {
      ok: false,
      error: `Could not inspect every repository in this workspace: ${unreadable
        .map((candidate) => `${candidate.repoName}: ${candidate.error}`)
        .join('; ')}`
    }
  }
  const selected = candidates.filter(
    (candidate): candidate is { repoName: string; target: T; selected: boolean } =>
      !isUninspectable(candidate) && candidate.selected
  )
  if (selected.length === 0) {
    return { ok: false, error: messages.none }
  }
  if (selected.length > 1) {
    return { ok: false, error: messages.many(selected.map((candidate) => candidate.repoName)) }
  }
  return { ok: true, target: selected[0]!.target }
}

/** Pick the sole child repo with staged changes. */
export function selectFolderWorkspaceCommitTarget<T>(
  candidates: readonly FolderWorkspaceChildCandidate<T>[]
): FolderWorkspaceOperationTarget<T> {
  return selectExactlyOne(candidates, {
    // Why: matches what a single-repo commit reports for an empty index, so the
    // renderer's existing failure copy stays accurate.
    none: 'nothing to commit',
    many: (repoNames) =>
      `Staged changes span multiple repositories (${repoNames.join(', ')}). ` +
      'Commit one repository at a time.'
  })
}

/** Pick the sole child repo currently running `operation`. */
export function selectFolderWorkspaceAbortTarget<T>(
  candidates: readonly FolderWorkspaceChildCandidate<T>[],
  operation: 'merge' | 'rebase'
): FolderWorkspaceOperationTarget<T> {
  return selectExactlyOne(candidates, {
    none: `No repository in this workspace has a ${operation} in progress.`,
    many: (repoNames) =>
      `More than one repository is mid-${operation} (${repoNames.join(', ')}). ` +
      `Abort one repository at a time.`
  })
}
