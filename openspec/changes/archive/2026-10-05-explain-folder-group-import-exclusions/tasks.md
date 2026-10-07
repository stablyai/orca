# Tasks

## 1. Host-owned diagnostic evidence

- [x] 1.1 Add optional bounded diagnostic types to `src/shared/project-group-types.ts`, including observed reason counts, at most 100 details, ignore-rule provenance, and omitted-detail metadata; verify typechecks and a response compatibility test accept payloads both with and without diagnostics.
- [x] 1.2 Extend existing policy evaluation in `nested-repo-scan-rules.ts` to expose the effective exclusion reason and source rule without changing boolean matching behavior; verify `nested-repo-scan-rules.test.ts` covers inherited/anchored rules, negation, overridden rules, and built-in precedence with unchanged decisions.
- [x] 1.3 Instrument `nested-repo-discovery.ts` at existing classification, exclusion, depth-boundary, and directory-read branches; verify `nested-repo-discovery.test.ts` covers zero results, unreadable directories, observed counts, shortened/omitted detail disclosure, and immutable progress snapshots without extra subtree reads or Git probes.
- [x] 1.4 Preserve breadth-first order, repository stops, symlink exclusions, and existing budgets; verify `nested-repo-discovery-queue.test.ts` and `nested-repo-glob-budget.test.ts` still pass and instrumented fixture assertions retain the original visited paths and candidate order.

## 2. Local and remote result transport

- [x] 2.1 Carry optional diagnostics through existing final/progress IPC results, SSH filesystem adaptation, and `projectGroup.scanNested` runtime replies; verify focused IPC/runtime tests preserve the selected execution host, checked read-error provenance, and bounded diagnostics.
- [x] 2.2 Preserve absent diagnostics in `normalizeNestedRepoScanResult` and handle unfamiliar reason values as neutral unavailable detail; verify renderer/contract tests use legacy payloads, unknown reasons, and Windows/POSIX host paths without rejecting valid repositories or claiming zero exclusions.

## 3. Visible Add Project explanations

- [x] 3.1 Add shared inline scan-explanation presentation next to existing found counts, with keyboard-operable expandable paths/rules and separate boundary/read-failure labels; verify renderer tests cover counts, `.gitignore` provenance, unreadable paths, omitted/shortened details, long paths, escaped text, and expanded-state accessibility.
- [x] 3.2 Add an explicit `Import folder as group` entry using existing host-specific picker/scanner paths and dialog-local intent; route Git roots only under that intent, and zero-result scans with reportable diagnostics, into persistent explanations before existing continuations. Verify local and host-path flow tests preserve uninterrupted ordinary single-repository browsing, expose no rescan/override controls, change no CLI commands or backend scan options, and do not modify `.git`/`.gitignore`.
- [x] 3.3 Retain existing generation/cancellation and host-routing guards, resetting explanation state when the attempt changes; verify stale-result, cancelled-attempt, host-change, SSH, paired-runtime, and legacy-host fixtures cannot display another path's evidence.
- [x] 3.4 Localize explanatory labels through existing catalogs and use documented tokens/primitives; verify localization checks and `pnpm run check:code-quality:changed` pass, with no tooltip-only critical explanation.

## 4. End-to-end qualification

- [x] 4.1 Extend hidden Electron Add Project coverage with disposable fixtures for a Git root selected through explicit group import, the same root selected through ordinary browsing, partially ignored siblings, and fully ignored/zero-result folders; verify uninterrupted ordinary browsing and persistent group-import explanations, expected unchanged import/open outcomes, and CDP screenshots under `ORCA_BACKGROUND_LAUNCH=1` without presenting windows or touching the user's official profile.
- [x] 4.2 Run focused scanner, matcher, transport, and renderer tests with `ORCA_BACKGROUND_LAUNCH=1 pnpm test <affected-test-paths>`; verify every specification scenario has a passing focused check and remote unknown/missing diagnostics degrade safely.
- [x] 4.3 Run `pnpm tc`, changed-file Oxlint/format checks, localization gates, and the focused Playwright spec with `--project electron-headless --workers=1`; verify the current change passes, report unrelated existing failures separately, and preserve the earlier folder-creation test work without silently including it in this feature.

Validation recorded: 163 focused tests and 3 freshly rebuilt hidden Electron tests pass. `pnpm tc`, changed-code quality, all localization catalog/extraction/coverage gates, runtime English catalog coverage, feature locale key/placeholder checks, formatting, and `git diff --check` pass. With separate user approval, the 12 pre-existing missing `worktree.nestedRemoval.*` keys were added to the six locale catalogs; their runtime catalog was regenerated. No localization policy or unrelated application code was changed.
