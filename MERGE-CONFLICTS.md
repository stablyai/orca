# Merging Orca into Phorca

Keep Phorca close to [upstream Orca](https://github.com/stablyai/orca). Prefer upstream
fixes, features, and structure, then reapply the smallest changes needed for:

1. **Phorca identity and installation safety:** retain the fork's app identity,
   executable/daemon isolation, and protection against installing upstream desktop
   binaries over the fork.
2. **Phorca CI and release operations:** retain the release-sync machinery and the
   minimal configuration needed for Phorca's required checks to pass.

The file map below records those contracts, not permission to preserve every old
implementation. If upstream now provides an equivalent implementation, use it and
remove the redundant fork code. Do not add unrelated features, refactors, or a wider
rebrand while resolving conflicts. Apply the same policy to Codex and Claude.

## Workflow exception: replace, do not merge

**Everything under `.github/workflows/` comes from Phorca's default branch, in full.**
Do not merge individual YAML sections or accept Orca's workflow additions, edits, or
deletions. The resulting directory must exactly match the recorded Phorca source,
including files Phorca has deleted. Review upstream workflow improvements separately
and apply approved changes to Phorca's default branch, not the sync PR.

This exception does **not** cover `.github/scripts/`, `.github/actions/`, or other
CI-related source. Merge those normally, retaining only the fork contracts below.
See [.github/ORCA_SYNC.md](./.github/ORCA_SYNC.md) for the automated sync procedure.

## Procedure for a cloud agent

1. Read [AGENTS.md](./AGENTS.md), this file, and the sync instructions. Inspect the
   working tree and whether a merge is already in progress. Preserve existing human
   changes and conflict resolutions; do not reset, clean, or restart an active merge.
2. Identify the refs explicitly:
   - `origin` is `phocassoftware/phorca`; `upstream` is `stablyai/orca`.
   - Fetch Phorca's default branch and record its immutable commit as
     `<PHORCA_WORKFLOW_SOURCE>`; the current default branch is `main`.
   - Record the fork branch's pre-merge commit as `<PHORCA_BEFORE>`. For a first
     sync branch created from Orca, use `<PHORCA_WORKFLOW_SOURCE>` instead: the
     update branch does not yet include Phorca's customizations.
   - Use the exact Orca tag/commit selected for the update as `<ORCA_TARGET>`.
     Scheduled syncs choose a stable desktop release at least 72 hours old.
     Manual overrides can bypass the wait, not the stable-release requirement.
     Do not substitute today's `upstream/main` for a selected release.
3. Before starting a new merge, inventory the fork against the shared ancestor:

   ```text
   git merge-base <PHORCA_BEFORE> <ORCA_TARGET>
   git diff --name-status <BASE> <PHORCA_BEFORE> -- . ':(exclude).github/workflows/**'
   git diff <BASE> <PHORCA_BEFORE> -- <path>
   ```

   Replace `<BASE>` with the first command's result. A direct comparison with a
   newer upstream tip also includes upstream work not yet merged; do not mistake
   that for fork customization. Fetch only the relevant branch/tag, not every ref.

4. Stay on the existing update branch and preserve its commits. If a merge is
   already in progress, continue resolving it. Otherwise, choose the merge target
   according to the branch's ancestry:

   - **First sync PR, created from Orca:** the `preserveBranch === false` path in
     `config/scripts/sync-orca-release.mjs` starts at the selected Orca release
     and restores Phorca's workflows. It has not incorporated Phorca's source
     changes. Merge the recorded Phorca default-branch commit into this branch:

     ```text
     git merge --no-commit --no-ff <PHORCA_WORKFLOW_SOURCE>
     ```

     This exposes the conflicts with Phorca. Merging `<ORCA_TARGET>` here would
     report already up to date because the branch already contains that release.

   - **Update branch already based on Phorca:** merge the selected Orca release
     into the branch:

     ```text
     git merge --no-commit --no-ff <ORCA_TARGET>
     ```

   In either case, resolve source conflicts by combining upstream changes with the
   contracts below, then follow steps 5–7 to restore workflows before committing.
   Use explicit refs, not an assumed meaning of `ours` or `theirs`. Do not keep an
   entire old source file just because it contains one fork change.

5. Replace the entire workflow tree from the recorded Phorca commit. Remove the
   tracked directory first so delete/modify conflicts cannot block restoration:

   ```text
   git rm -r -f --ignore-unmatch -- .github/workflows
   git restore --source=<PHORCA_WORKFLOW_SOURCE> --staged --worktree -- .github/workflows
   ```

   Run the removal in all cases; run the restore only if the source commit contains
   `.github/workflows/` (check with `git ls-tree -d <PHORCA_WORKFLOW_SOURCE> -- .github/workflows`).
   If it has no workflow directory, leave the directory absent. This is the one
   deliberate whole-directory replacement: remove upstream-only files, not just
   overwrite matching filenames. Workflow-only conflicts are not a reason to take
   upstream workflows.

6. Check both textual conflicts and semantic coupling, including files Git merged
   cleanly. Stage resolved files individually, then run the checks below. Confirm:

   ```text
   git diff --name-only --diff-filter=U
   git diff --cached --check
   git diff --check
   git diff --exit-code <PHORCA_WORKFLOW_SOURCE> -- .github/workflows
   ```

   All must pass; the first must print no paths. Inspect untracked files too.

7. Commit the resolved merge and push fixes to the existing update branch,
   preserving reviewer commits; do not force-push over them. Report the selected
   Orca commit, retained overrides, checks actually run, and any unavailable
   platform evidence. Leave final PR review and merging to a maintainer, who must
   require passing CI on the final resolved revision and use **Create a merge
   commit**, not squash/rebase. Do not automatically merge the PR.

## Audited fork delta

Snapshot: branch `lfa9603/Resolve-prs` at `243e5218ca`, shared Orca ancestor
`9af6a3d79895a4a9673b3948d32fec4bd4a58b7d`. Excluding workflows, there are
**21 implementation/configuration files, 19 test files, and 5 documentation/instruction
files: 45 files total.** Recompute the inventory for each merge; these counts and
paths are a starting map, not a fixed allowlist.

### 1. App identity and local-build compatibility

- `config/electron-builder.config.cjs`: keep `appId: 'com.phocassoftware.phorca'`
  and the Windows `afterPack` executable-identity writer described below.
- `src/shared/local-build-compatibility-contract.json` and
  `src/shared/local-build-compatibility-contract.ts`: keep the same Phorca app ID
  in both representations. Adopt upstream state-schema and daemon-protocol changes
  together with their runtime constants; do not freeze old protocol numbers.
- Current packaging has `productName: 'Phorca'` and Windows
  `executableName: 'Orca'`. `package.json` still names the package/CLI `orca`;
  macOS uses `Phorca.app`, Linux uses `orca-ide`, and technical identifiers such as
  the `orca` URL scheme and `ORCA_*` environment variables remain upstream names.
  Do not infer a required `Phorca.exe` rename from rebrand fixtures.
- Keep upstream artifact names, links, attribution, signing checks, and release
  infrastructure unless a recorded fork contract requires a change. Do not
  globally replace `Orca`, `orca`, or `stablyai`.

Companion tests:
`config/scripts/electron-builder-config.test.mjs`,
`config/scripts/electron-builder-mac-channel-config.test.mjs`,
`config/scripts/mac-build-compatibility.test.mjs`,
`src/shared/local-build-compatibility.test.ts`,
`src/main/local-builds/local-build-candidate.test.ts`, and
`src/main/local-builds/local-build-compatibility-contract.test.ts`.
Keep generated metadata and its readers aligned; upstream Orca's app ID must remain
incompatible with the fork's local-build contract.

### 2. Windows executable identity, CLI, and daemon host

- `config/scripts/windows-executable-identity.cjs`: retain the packaging-time
  identity file `resources/app-executable-name.txt`, derived from the packager's
  resolved executable name. Validate that the named packaged executable exists;
  do not guess its name from branding text.
- `native/windows-cli-launcher/src/main.rs`: resolve the executable through
  that identity file, require a safe `.exe` basename and an existing file, and
  fail on missing/invalid metadata rather than falling back to a hardcoded
  `Orca.exe` or `Phorca.exe`. Keep direct execution, argument escaping, inherited
  environment handling, and the existing `ELECTRON_RUN_AS_NODE`/CLI contract.
- `src/main/daemon/daemon-host-relocation.ts`: scope the Windows runtime copy to
  `%LOCALAPPDATA%\<executable-basename>\daemon-host\<version>\`, derived from
  `process.execPath`; keep the existing `userData` fallback. For `Phorca.exe` this
  is the `Phorca` root; for the currently configured `Orca.exe` it is `Orca`.
  Never hardcode either product's root independently of its executable.
- `config/nsis/orca-installer-hooks.nsh`: use
  `$LOCALAPPDATA\${PRODUCT_FILENAME}\daemon-host` for uninstall cleanup, matching
  the runtime basename. Keep the `${isUpdated}` guard: an update must not perform
  real-uninstall cleanup. Preserve upstream additive Markdown registration and
  legacy `orca-terminal-daemon.exe` cleanup in the same include.
- Preserve upstream daemon survival and safety: copy the signed executable under
  its original basename, retain required runtime files, stage atomically, and
  preserve hosts when liveness is `live` or `unverifiable`. These are not reasons
  to restore an older fork implementation over upstream fixes.
- `src/main/orcad/orcad-browser-provider.ts`: keep installed Windows Phorca
  candidates before Orca within each of the `LOCALAPPDATA` and `ProgramFiles`
  locations. Retain the Orca fallback and upstream macOS/Linux behavior.
- `config/scripts/smoke-packaged-cli.mjs`: retain the Windows 60-second timeout
  for Defender inspection and cleanup retries for Windows file locks without
  masking the original failure. Other platforms retain their existing timeout.

Companion tests:
`config/scripts/windows-executable-identity.test.mjs`,
`config/scripts/build-windows-cli-launcher.test.mjs`,
`config/scripts/electron-builder-markdown-associations.test.mjs`,
`src/main/daemon/daemon-host-relocation.test.ts`, and
`src/main/orcad/orcad-browser-provider.test.ts`.
Keep rebranded-executable coverage even though the Windows executable is named Orca.
Read and maintain
[Windows daemon-host relocation](./docs/reference/windows-daemon-host-relocation.md)
and [Windows EDR posture](./docs/reference/windows-edr-posture.md) when touching this
boundary. Do not confuse the historical renamed daemon image with current behavior.

### 3. Desktop updates are managed outside the upstream updater

- `electron.vite.config.ts`: keep main-process `PHORCA_MANAGED_BUILD: 'true'`.
  `src/types/build-constants.d.ts` declares the corresponding boolean.
- `src/main/updater.ts`: for managed builds, suppress automatic desktop checks,
  downloads, and installation; expose no upstream release-build list and report
  that the app is not quitting for an update. The user-initiated menu check opens
  the Phorca releases page instead. Keep the unmanaged upstream path intact.
- `src/shared/release-channel.ts`: retain
  `PHORCA_RELEASES_URL = 'https://github.com/phocassoftware/phorca-releases/releases'`.
  This binary-download repository is distinct from both the fork's source
  repository and the upstream release source.
- `src/main/releases-page.ts`: open that URL in the system browser. Preserve the
  logged failure and visible error with a manual URL if opening fails.
- `src/main/updater/updater-setup.ts`: retain the `suppressDesktopUpdates` boundary.
  Updater state and event handlers still initialize, but startup/wake/focus
  polling, nudges, and handler-triggered automatic rechecks must not restart
  desktop updates. Do not replace setup with a blanket early return.
- **Do not disable remote/headless-server updates.** Keep the explicit remote
  support/check/download/install APIs and upstream SSH execution ownership.
  If upstream adds new desktop update entry points, apply the same managed-build
  boundary rather than allowing a new path to install Orca over Phorca.

Companion tests: `src/main/releases-page.test.ts` and
`src/main/updater.startup-scheduling.test.ts`. Retain the assertion that remote
update support remains available without desktop polling.

### 4. Release sync and shared release helpers

- `config/scripts/sync-orca-release.mjs` and
  `config/scripts/sync-orca-release-action.mjs`: keep the fork's source-sync
  implementation. Source releases come from `stablyai/orca`; PR operations target
  the executing Phorca repository. Keep these repositories separate.
- Preserve highest-semantic-version selection of published, non-draft,
  non-prerelease desktop `vX.Y.Z` releases at least 72 hours old. Manual tags must
  be validated before Git/API calls and bypass only the age requirement.
- Keep one update PR on `codex/AI-101-orca-release-sync`, preserving manually
  resolved commits on an unmerged update branch. A closed, unmerged PR pauses
  scheduled updates; manual execution can reopen it. Do not downgrade a manually
  selected newer release, even across divergent upstream histories.
- Keep clean-disposable-checkout checks, real merge ancestry, exact expected-head
  force-with-lease protection, and failure without changing the remote branch on
  source conflicts. Preserve PR-body notes outside the generated sync block and
  the retry path when a push succeeds but updating PR metadata fails.
- Keep whole-directory workflow replacement and the final equality check against
  Phorca's base tree. A workflow-only refresh must still work without a newer
  eligible release.
- Preserve the write-token trust boundary: the action runs only from Phorca's
  default branch, uses trusted scripts with Git hooks disabled, and does not
  install dependencies or execute fetched upstream code.
- `config/scripts/latest-stable-release.mjs`: retain strict stable-tag parsing
  (including leading-zero/unsafe-integer rejection), the metadata-preserving
  `latestStableDesktopRelease` selector, and caller-supplied eligibility.
- `config/scripts/create-draft-release.mjs`: retain the exported
  `compareDesktopVersions` shared by the selectors/sync. Keep it in this module:
  release-cut restores this file onto older tags. Preserve upstream publication
  behavior and parameterized repositories; sync itself does not publish releases.
- `.github/scripts/pr-test-loc-table.mjs`: retain reusable `mergeMarkedBlock`
  alongside `mergeLocBlock`; both the LoC summary and sync reuse it. Replace only
  the matching generated block, preserving reviewer text and ignoring an orphan
  end marker before the start marker.

Companion tests:
`config/scripts/latest-stable-release.test.mjs`,
`config/scripts/sync-orca-release.test.mjs`,
`config/scripts/sync-orca-release-api.test.mjs`, and
`config/scripts/pr-test-loc-summary.test.mjs`.
Keep workflow-coupled expectations aligned with Phorca's retained workflows.
Maintain the operational instructions in `.github/ORCA_SYNC.md`.

### 5. CI guard and deterministic runtime test

- `.github/scripts/check-root-directory-entries.mjs`: add `MERGE-CONFLICTS.md`
  to upstream's reviewed root-entry allowlist; retain other approved upstream
  entries and the guard's protections. Do not disable the guard.
  Companion: `config/scripts/check-root-directory-entries.test.mjs`.
- `src/main/runtime/orca-runtime-tests/lineage-and-scan-cache-part-03.spec.ts`:
  retain deterministic per-repository scan-expiry coverage. Upstream now uses
  `vi.setSystemTime()` without advancing runtime timers and mocks the repository
  fingerprint so unchanged Git state cannot hide the rescan. Keep its behavior
  assertions and restore the spy and timers afterward.
- `AGENTS.md`: retain the entry-point link to this policy when taking upstream
  instruction updates. This file, the sync guide, and the two Windows references
  above account for the five documentation/instruction files in the inventory.

## Verification before accepting a merge

- Run from the repository root with the existing dependency/install policy.
  Set `ORCA_BACKGROUND_LAUNCH=1` in the runner environment for tests and app
  launches. Never reveal windows or steal desktop focus.
- Run the companion tests for affected groups with
  `pnpm test <test-path> [<test-path> ...]`. The runtime `.spec.ts` fragment is
  imported by `src/main/runtime/orca-runtime.test.ts`; run that entry point,
  not the fragment alone. Run the existing draft-release tests if changing its
  shared comparator/publication code.
- Run `pnpm tc`, `pnpm run check:code-quality:changed`, and the relevant build
  checks. Exercise the built managed-update path: no desktop polling/download/
  install, menu opens the private releases URL, and remote update support remains.
  Tests running without the compile-time flag alone do not prove managed behavior.
- For packaging changes, build the affected platform artifacts and run
  `node config/scripts/smoke-packaged-cli.mjs --app-dir=<unpacked-app-path>`. On Windows,
  verify the emitted executable identity, CLI argument forwarding, daemon copy
  root, and uninstall/update ownership agree. Use isolated CI for installer and
  native-focus checks; do not uninstall the user's running app.
- Preserve SSH, folder-workspace, platform, and mixed-version wire behavior from
  upstream. A desktop-only fork rule must not accidentally disable host behavior.
- Review the resolved fork diff, including cleanly merged files: every retained
  override must serve identity/installation safety or Phorca CI/release operations.
  Require passing final-revision CI. Do not disable checks, weaken behavioral
  assertions, or claim unrun checks passed.
