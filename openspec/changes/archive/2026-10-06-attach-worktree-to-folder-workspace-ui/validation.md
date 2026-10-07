# Validation

Evidence recorded 2026-10-07 UTC. Checks ran in this worktree; no commit or archive performed.

## Unit and regression checks

- Configured Vitest runner: 134 tests passed across 12 files. Suites cover folder candidates, menu policy, folder picker, captured transition, existing Git picker/context menu, folder attachment actions, lineage state, and CLI guide generation.
- Configured rerun of `WorktreeCard.lineage.test.tsx`: 4 tests passed. An earlier unconfigured runner alert is not acceptance evidence.
- Commands used `ORCA_BACKGROUND_LAUNCH=1 pnpm test <affected paths>` with `config/vitest.config.ts`.
- Logs: `/tmp/orca-folder-attach-regressions.log`, `/tmp/orca-folder-attach-card-rerun.log`.

## Mocked transport checks

Candidate/action tests cover captured owner and exact identity routing, host isolation, stale instances, omitted versus empty workspace lineage, rejected/unknown/unverified writes, and conflicting parent mutations. These are mocked transport checks, not real SSH or mixed-version server acceptance.

## Real rendered acceptance

`tests/e2e/folder-workspace-nesting.spec.ts` passed with the `electron-headless` project, one worker, isolated disposable profile/home and repositories, and `ORCA_BACKGROUND_LAUNCH=1`.

The test exercises actual right-click folder attachment, search and mouse selection, keyboard selection, Escape cancellation, replacement of an existing Git parent, folder reassignment, detachment, sidebar nesting/collapse counts, board folding, repository metadata and branch hover, and full application shutdown/relaunch. Checkout identities and branch names remain unchanged. The test captures a hidden-renderer CDP screenshot and asserts no visible windows after relaunch.

A first restart assertion compared repository enumeration order; sorting identity snapshots corrected the test without changing application behavior. Final run: 1 passed (1.8 minutes).

Log: `/tmp/orca-folder-attach-restart-verified.log`.

## Release checks and preservation

- `pnpm tc`: passed.
- Changed-file `oxfmt` and focused `oxlint`: passed. A callback dependency finding was fixed before final quality acceptance.
- `pnpm run check:code-quality:changed`: passed, zero new findings across 87 changed files, including design-system and casting checks.
- `pnpm run check:max-lines-ratchet`: passed, no new bypasses.
- Localization catalog, required runtime catalog, and extraction checks: passed. Existing non-English catalogs still have 66 missing entries each; no claim of full catalog coverage.
- `git diff --check` and `git diff --cached --check`: passed; repeated when recording this evidence.
- Backup comparison preserved 91 original files byte-for-byte. All original entries in six locale catalogs were reconstructed from HEAD plus the pre-feature patch and verified unchanged. The runtime English projection and nesting acceptance test were intentionally updated. Existing folder-import, CLI-guide, nesting, and repository-origin work remains preserved.
- Logs: `/tmp/orca-folder-attach-final-types.log`, `/tmp/orca-folder-attach-quality-final.log`, `/tmp/orca-folder-attach-localization-final.log`.

## Limits

- No real SSH or paired mixed-version environment was available for acceptance. Mocked unreachable/older-host responses do not prove those deployments work.
- Broad optional `pnpm run typecheck:e2e` has a previously observed non-gating baseline, including conflicting `Window.__paneManagers` declarations. It was not used as a clean release gate or expanded into unrelated fixes.
- Development CLI symlink installation under `/usr/local/bin` reports permission denied. Acceptance used the worktree's bundled CLI and passed without changing that system path.
- User's live profile was not used for acceptance mutations.

## Follow-up UI changes (2026-10-07 UTC)

Added after the original acceptance run. Each has unit coverage and the changed-code gate, `pnpm tc`, `max-lines`, and localization checks passed afterward.

- Worktree right-click menu no longer offers `Remove from group` (it ungrouped the whole repo). The project header menu keeps it.
- Folder-attached worktrees show `Remove from Folder Workspace` and `Change Parent Worktree...`. Git parents keep `Remove from Parent`. Six locales translated. Hidden E2E selector updated and passing.
- `Attach to Folder Workspace…` and picker title use Title Case in English.
- Folder-attached children show a display-only `repo/` title prefix; rename saves only the real name. The gray repo metadata line is gone. Hidden E2E asserts this and passes.
- Folder workspace PR list: row click activates the attached worktree and opens the Checks tab; a separate chevron expands inline details. Unit-tested; real-app check recorded below.

### Real-app check with computer use (2026-10-07 UTC)

Driven through the pi computer-use plugin against the user's running dev app (restarted with current code). Observation and navigation only; no data was changed and no item was invoked.

- PR row click: clicking the PLAT-1612 row (PR #25376) in the folder workspace's Review checks list switched to that worktree and opened the Checks tab. Confirmed by screenshot.
- Right-click menu on a folder-attached worktree showed `Attach to Folder Workspace…`, `Change Parent Worktree…`, and `Remove from Folder Workspace`, with no `Remove from group`.
- Sidebar titles showed the `deploy/` prefix and no gray repo metadata line.

Remaining limits: real SSH and paired mixed-version hosts are untested; `typecheck:e2e` broad baseline remains non-gating.
