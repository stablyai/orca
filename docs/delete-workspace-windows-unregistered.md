# Delete Windows Workspace Without False Unregistered Error

## Problem

GitHub issue [#5864](https://github.com/stablyai/orca/issues/5864) reports that Orca on Windows v0.14.80 fails to delete a workspace created from a project `+` button:

`Error invoking remote method 'worktrees:remove': Error: Refusing to delete unregistered worktree path: C:/Users/andy/orca/workspaces/ops-tools/packaging-improvements-2`

Relevant flow:

- Renderer delete calls local IPC for local targets in `src/renderer/src/store/slices/worktrees.ts`.
- Preload exposes that as `worktrees:remove` in `src/preload/index.ts`.
- IPC delete lists Git worktrees, matches the requested path, and throws the unregistered error if no registered entry matches in `src/main/ipc/worktrees.ts`.
- Runtime RPC delete has the same registered-worktree gate in `src/main/runtime/orca-runtime.ts`.
- Windows create/list coverage exists in `src/main/ipc/worktrees-windows.test.ts`, but Windows delete coverage is missing.

## Root Cause

Delete is right to refuse arbitrary paths. This bug is a false negative in the proof step: Orca asks Git for the authoritative registered worktree list, but the list does not contain an entry equivalent to the project-created target.

Do not fix this by adding another path-normalization layer after the list. `findRegisteredDeletableWorktree` delegates to `areWorktreePathsEqual`, which already treats `C:/...`, `C:\...`, and drive-case variants as equal while keeping POSIX/WSL paths distinct. `git/worktree.removeWorktree` has a similar comparator for its fallback branch lookup.

The credible failure surfaces are before or around that comparator:

- Delete may list through a different local runtime than create/list/selector resolution, especially for project runtime settings on Windows.
- `listWorktrees` currently returns `[]` for several Git/list failures. In delete, that collapses "could not prove registration" into the misleading unregistered-path error.
- Runtime selector/list resolution calls `listRepoWorktreesForResolution(repo)`, which currently omits local project runtime options.
- Runtime removal validates a registered row, but then calls `removeWorktree` without `knownRemovedWorktree`, allowing the Git helper to rescan under the supplied options.
- Some runtime cleanup paths still omit or recompute local runtime options instead of using the option set captured for the delete.

Implementation must start with a failing regression. If an equivalent Windows row is present in the registered list under the right options, deletion should succeed without further path comparator changes.

## Non-goals

- Do not allow deletion of existing unregistered directories.
- Do not bypass the main-worktree, nested-worktree, local dirty-worktree, archive-hook, branch-preservation, or concurrent-delete guards.
- Do not change delete dialog UI/copy.
- Do not change SSH provider semantics.
- Do not add a broad path abstraction or metadata migration.

## Design

1. Capture one repo-scoped local Git option set for the delete.
   - For local repos, use the repo's project runtime options from `getLocalProjectWorktreeGitOptions(store, repo)`. This is already repo-scoped and surfaces repair-required project runtimes before any Git command.
   - Do not use `getLocalGitOptionsForRegisteredWorktree` for delete. It scans all repos and uses native `path.resolve`, which is not a safe Windows-equivalence test on macOS/Linux test hosts.
   - Do not choose options from a worktree path alone. The parsed `repoId` is the authority for local runtime selection; exact-ID fallback after selector failure should still use the owning repo's project runtime options.
   - Keep SSH paths on the existing provider branch.

2. Make the authoritative Git list strict enough for delete.
   - Delete must distinguish "Git listed zero matching worktrees" from "Git listing failed." A selected-runtime Git/list failure should surface the underlying failure, not turn into `Refusing to delete unregistered worktree path`.
   - If this requires a strict list API beside `listWorktrees`, keep it narrow and delete-only; do not change polling/list UI behavior that intentionally tolerates transient Git failures.
   - The registered row returned by Git remains the canonical removal target after `findRegisteredDeletableWorktree` succeeds.

3. Thread the captured option set through the full local removal path.
   - `listWorktrees`, archive hooks, orphan proof reads, missing-path checks, clean preflight, `git worktree remove`, branch cleanup, recursive orphan cleanup, filesystem delete, push-target cleanup, and `git worktree prune` must all use the same captured options.
   - Do not recompute project runtime options later in the operation. A project runtime setting change during an in-flight delete must not split one deletion across two runtimes.
   - IPC already passes `knownRemovedWorktree` to `removeWorktree`; keep that behavior.
   - Runtime removal must also pass `knownRemovedWorktree` so branch cleanup uses the validated row and avoids a second list.
   - Replace current runtime cleanup call sites that omit `localWorktreeGitOptions` for push-target remote cleanup.
   - Replace prune calls that recompute `getLocalProjectGitExecOptions(...)` with `{ cwd: repo.path, ...localWorktreeGitOptions }`.

4. Fix runtime resolution/listing.
   - Update `listRepoWorktreesForResolution(repo)` to call `listRepoWorktrees(repo, getLocalProjectWorktreeGitOptions(store, repo))` for local repos.
   - Runtime exact-ID deletes should re-list Git under the captured options before destructive work; selector caches are convenience only, not delete authority.
   - Runtime archive hooks should use the captured options rather than `this.getLocalGitExecutionOptionArgs(repo)[0]`.

## Data Flow

- Delete action -> `removeWorktree(worktreeId, force)` in renderer.
- Local target -> `window.api.worktrees.remove({ worktreeId, force, skipArchive })`.
- Main parses `repoId` and `worktreePath`.
- Main resolves the repo and captures one local Git option set for that repo.
- Main strictly lists registered Git worktrees with those options.
- Main matches requested path to registered path with `areWorktreePathsEqual` via `findRegisteredDeletableWorktree`.
- Main uses the registered canonical path for hooks, preflight, watcher close, Git removal, orphan cleanup, metadata cleanup, and sidebar refresh. PTY teardown remains keyed by the exact worktree ID.

Runtime RPC follows the same rule after selector resolution, and exact-ID fallback must still re-list Git before destructive work.

## Edge Cases

- `C:/...`, `C:\...`, and drive-letter case variants refer to the same Windows worktree.
- POSIX WSL paths and Windows paths must not compare equal unless `listWorktrees` translated them through the selected WSL options.
- UNC paths, drive-letter paths, and `/mnt/<drive>` paths need explicit tests because Node path behavior is platform-specific on macOS/Linux test hosts.
- Main worktree deletion is still rejected.
- Parent worktree deletion is still rejected if another registered worktree is nested inside it.
- Existing unregistered directories are still rejected, even with `force`.
- Already-missing Orca-known worktrees still clean metadata only.
- Orphaned Orca-created worktree directories still require proof through the `.git` file before recursive deletion.
- Multi-window IPC deletes coalesce only for the same exact worktree ID and options. Equivalent Windows paths with different IDs, or IPC/runtime deletes racing each other, must degrade to safe missing/orphan handling or a protected error.
- External Git mutation between list and `git worktree remove` is handled by the existing missing/orphan branches; keep those branches under the same captured runtime options.
- Project runtime setting changes during an in-flight delete affect only later deletes.
- SSH deletes still use SSH Git/filesystem providers and do not touch local paths.

## Test Plan

- Unit:
  - `pnpm vitest run src/main/ipc/worktrees-windows.test.ts`
  - `pnpm vitest run src/main/ipc/worktrees.test.ts --testNamePattern "local worktree removal|selected WSL project runtime|unregistered delete|contains another registered|already-missing"`
  - `pnpm vitest run src/main/runtime/orca-runtime.test.ts --testNamePattern "worktree removal|selected WSL project runtime|unregistered delete|contains another registered|already-missing"`
- Required new coverage:
  - IPC Windows delete regression: request path uses `C:/...`, Git registered row uses backslashes and/or different drive-case, delete succeeds, hooks/preflight/removal use the canonical registered path, `knownRemovedWorktree` is passed, metadata is removed, and `worktrees:changed` emits.
  - Runtime Windows delete regression with the same path mismatch. Assert selector/list resolution and final removal both use selected project runtime options, and `knownRemovedWorktree` is passed.
  - Strict-list failure regression: a selected-runtime list failure rejects with the list failure, not the unregistered-path error.
  - Negative Windows/WSL mismatch: POSIX `/mnt/c/...` or WSL-native paths must not match unrelated Windows paths unless translated by the selected WSL options.
  - Runtime cleanup regressions for already-missing/orphan/push-target cleanup under selected WSL options.
- Integration/e2e:
  - Electron smoke with a disposable local repo/worktree: delete succeeds, row disappears, no new delete UI regressions.
  - Real Windows validation is preferred. macOS/Linux unit tests can cover comparator and option plumbing, but they cannot fully prove Node and Git path behavior on Windows.
- Full checks:
  - `pnpm typecheck`
  - `pnpm lint`

## UI Quality Bar

No intentional UI change. Existing delete dialog, progress state, toast behavior, and sidebar row removal should remain visually unchanged and follow `docs/STYLEGUIDE.md`.

## Review Screenshots

No design screenshots are required for a backend-only fix. If the PR needs Electron smoke evidence, attach only:

1. Disposable workspace delete confirmation before confirming.
2. Sidebar after successful deletion with the row gone.

Do not spend review time manufacturing a protected/error screenshot; cover that with unit tests.

## Rollout

1. Add focused Windows-path delete regression tests.
2. Add strict delete listing or equivalent failure propagation.
3. Update runtime selector/list resolution to use local project runtime options.
4. Thread captured options and `knownRemovedWorktree` through IPC/runtime delete paths.
5. Run focused tests, typecheck, lint.
6. Electron-validate the unchanged delete UI on a disposable workspace and collect screenshots only if required.

## Lightweight Eng Review

- Scope: delete-only; no renderer changes, no new deletion authority, and no broad path-normalization rewrite.
- Architecture/data flow: local IPC and runtime RPC both keep Git as the authority. The fix is to ask Git through the correct project runtime, treat list failures as failures, then use Git's registered row as the canonical removal target.
- Failure modes covered:
  - Windows slash/drive-case mismatches.
  - Wrong or failed local project runtime listing.
  - Runtime selector resolution using host listings.
  - Runtime branch cleanup rescanning instead of using the validated row.
  - Metadata absent or stale during already-missing cleanup.
  - Existing unregistered directory remains protected.
  - Main and nested registered worktrees remain protected.
  - SSH paths stay provider-owned.
- Performance/blast radius: no material concern if the delete path performs one strict authoritative list and passes `knownRemovedWorktree` to avoid the helper rescan.
- Feasibility: this is not a "one comparator call" fix. The current APIs make `listWorktrees` failures look like empty lists, and runtime selector resolution currently omits local runtime options.
- UI quality bar: no UI-visible design change; Electron should judge that existing delete dialog, progress, toast, and row removal still look unchanged against `docs/STYLEGUIDE.md`.
- Required review screenshots: none for the backend fix; optional disposable-workspace smoke screenshots only if the PR process asks for visual evidence.
- Residual risks: true Windows filesystem/Git spelling behavior still depends on a Windows runner or user validation; macOS/Linux tests cannot fully model it.
