# Malformed worktree registration removal

Git can report a linked worktree at `<checkout>/.git` when its administrative
`gitdir` backlink incorrectly ends in `.git/.git`. That reproduces #17316's
validation error. The reproduction establishes the malformed registration, not
which program created it; current OMP uses ordinary `git worktree add`.

Orca's desktop and runtime removal entry points use registration-only recovery
when Git positively marks the row prunable, the row has a named local branch and
HEAD, it is neither main nor locked, and the execution filesystem confirms the
selected `.git` path is a regular file. Missing or unknown evidence does not
permit this recovery. A symlink or directory is not a regular-file proof.

Recovery reuses `git worktree prune` followed by a strict worktree listing that
must confirm the selected registration is gone. It does not delete the selected
file, infer a parent path for deletion, or delete the branch. Archive hooks and
checkout teardown are skipped because the selected row is not a checkout.

Two consequences are intentional:

- Git's prune also clears other stale, unlocked registrations in the repository;
  it is not a path-scoped command. Live and locked registrations remain Git's
  responsibility, and Orca verifies that the requested registration disappeared.
- The surviving checkout's `.git` file points at removed administrative metadata.
  Files and its named branch are preserved; recovery removes the broken navigation
  entry and does not repair or claim to restore that checkout.

Native and WSL checks use the existing execution-filesystem accessor. WSL prune
and verification use the same selected distro. Paired runtimes run the recovery
on their owning host. Direct SSH does not enter this local recovery: its current
provider has no registration-only removal operation, and a failed remote removal
never authorizes a local fallback.

The Git commands already exist in the 2.25-compatible cleanup path. On an older
Git that cannot positively attest this file-shaped registration as prunable, Orca
refuses this recovery. Deferred deletion independently rejects non-directory and
symlink targets, so force cannot move a `.git` file into deletion trash.

Regression coverage is in `worktree-prunable-git-file.test.ts`,
`worktrees-removal-recovery.test.ts`, and
`worktree-deferred-removal-real-git.test.ts`. The latter reproduces the exact
malformation against the installed Git binary in a disposable repository and
checks surviving file contents, branch HEAD, and removed registration.
