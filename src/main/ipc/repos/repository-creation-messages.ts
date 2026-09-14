// Why: shared so all three creation lanes (local, SSH, runtime) word these identically.

// Why: conditional, not asserted — reaching the commit step does not prove the .git is still
// there (a hook or another process may have removed it), and we will not send someone hunting
// for a path that no longer exists.
export const LEFTOVER_GIT_DIR_RETRY_HINT =
  'If a .git directory was left behind, remove it before retrying.'

// Why: name both remedies. We cannot tell a user's own repository from a .git a failed attempt
// left behind, and offering only "pick another location" contradicts the retry hint they just read.
export function alreadyARepositoryError(name: string): string {
  return `"${name}" is already a git repository. Choose a different name or location — or, if an earlier attempt left a .git directory behind, remove it and try again.`
}

// Why: a probe that did not complete is not evidence of absence, so we refuse — but as a
// temporary condition the user can retry, not as a verdict about the target.
export function repositoryCheckUnavailableError(name: string, message: string): string {
  return `Could not check whether "${name}" is already a git repository: ${message}. Try again.`
}
