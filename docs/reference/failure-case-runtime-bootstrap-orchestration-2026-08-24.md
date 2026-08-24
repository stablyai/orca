# Runtime bootstrap/orchestration failure receipt — 2026-08-24

Each entry separates symptom, cause confidence, correction, and verification. No secret values are included.

| Failure                                                                | Classification and cause                                                                           | Correction                                                                                    | Verification                                        |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Initial B1 focused tests reported 34 failures                          | Implementation defect: temporal-dead-zone access, incorrect Map flag lookup, and malformed fixture | Corrected routing/fixture code before splitting B1                                            | B1 focused suite: 106 passed                        |
| Vitest startup `spawn EPERM`                                           | Environment restriction: Windows sandbox blocked Vite child process                                | Re-ran the identical bounded test outside sandbox                                             | C1 shared test: 3 passed                            |
| Oxfmt setup `spawn EPERM`                                              | Environment restriction: Windows sandbox blocked formatter child process                           | Re-ran the identical bounded check outside sandbox                                            | Formatter ran successfully on the 12-file C1 set    |
| Typechecks could not write `tsconfig.*.tsbuildinfo`                    | Environment restriction: sandbox denied incremental receipt writes                                 | Re-ran canonical scripts outside sandbox                                                      | node, CLI, and canonical web typechecks passed      |
| Direct `tsc -p config/tsconfig.web.json` emitted TS6307 imports        | Verification-command error: broad build config used instead of canonical `tsconfig.tc.web.json`    | Used `pnpm run typecheck:web`                                                                 | Canonical web typecheck passed                      |
| Renderer config path `src/renderer/tsconfig.json` did not exist        | Verification-command error                                                                         | Queried configs and selected the package script                                               | Canonical web typecheck passed                      |
| A2 lint found four `eslint(curly)` errors                              | Implementation defect in new status tests                                                          | Added braces and amended A2                                                                   | Targeted oxlint passed; A2 SHA `2cd7b742fa`         |
| Broad code-map search scanned generated assets and truncated over 3 MB | Investigation-command scope error                                                                  | Restricted later searches to typed source globs and named directories                         | Later searches returned bounded source-only results |
| Direct oxlint reports `max-lines` in pre-existing large files          | Baseline policy finding, not introduced by C1                                                      | Preserve baseline and use canonical changed-file quality gates                                | Pending final C1 gate receipt                       |
| Creating a new `docs/failure-cases` directory was denied               | Workspace sandbox boundary did not include this Orca checkout for shell directory creation         | Stored the receipt in the existing writable `docs/reference` directory via patch              | This tracked receipt is readable in the worktree    |
| New code-map/SSOT files were absent from ordinary `git status`         | Repository policy ignores `docs/**`                                                                | Keep the documents in the canonical docs tree and explicitly stage only the three named files | Pending staged-diff verification                    |

Additional C1 implementation incident: the first runtime projection test classified a renderer-backed live parent as `FROZEN`. The implementation had queried only `getLivePtyForHandle`, which excludes valid renderer leaf authority. It now queries the canonical `getLiveTerminalPaneKey` boundary. The focused regression passed: 1 passed, 1185 filtered/skipped.

C2's first RPC run failed because the new rebind schema was inserted before the existing `AskParams.superRefine` chain closed, so rebind incorrectly required ask question/resume fields and Node typecheck failed. The ask refinement was restored to `AskParams`, and `ParentRebindParams` is now an independent object schema.

The first C2 schema investigation guessed two nonexistent paths (`db/index.ts` and `schema/schema-version.ts`). Bounded `rg --files` established the actual barrel/version locations. The schema was implemented through `db.ts`, `db/contract-constants.ts`, and the existing migration module; no guessed file was created.

The first combined C1/B1 regression then failed one identity-less worker completion fixture. That fixture overrode terminal lookup for the worker and returned no coordinator pane, which correctly became parent loss under the new policy. The fixture now models its intended live coordinator explicitly; the product guard remains fail-closed.

The canonical changed-code quality script again failed on Windows with `spawnSync pnpm.cmd EINVAL`. This is a harness defect already observed before C1, not a lint verdict. Direct oxlint completed and reported only the known `max-lines` findings in `agent-status-types.ts` and `orchestration-send.test.ts`; no new rule finding was emitted.

The passing CLI regression suite writes expected parser/reset messages and three existing mocked-runtime `Cannot read properties of undefined (reading 'catch')` lines to stderr. The suite still completed 134/134; these lines are test-fixture output, not silently treated as product success evidence.

Two investigation commands also requested nonexistent guessed paths (`db/index.ts` and `schema/schema-version.ts`). The tracked file map established `db.ts`, `db/orchestration-db.ts`, and `db/contract-constants.ts` as the actual locations; no product cause was inferred from those lookup errors.

D1 documentation and multi-file edits hit several `apply_patch` verification errors: one added Markdown line lacked the required `+` prefix, one patch targeted the same gate file for delete and add, and some hunks assumed pre-format spacing. Each failed atomically. The edits were split into exact operations after reading the current lines; no partial product mutation was accepted as evidence.

Additional global-shell incident: every tool command printed `starship::print: Under a 'dumb' terminal` because the user CurrentHost PowerShell profile initialized Starship unconditionally while tool runners set `TERM=dumb`. Only Starship initialization is now guarded by interactive `ConsoleHost` and non-dumb-terminal checks; zoxide, PSFzf, and cache wiring remain unchanged. A fresh profile-loaded command printed `profile-load-ok`, reported `StarshipInteractive=False`, and emitted no Starship error.

Earlier environment/tool corrections retained from A1/B1/A2: a missing Prettier command was replaced with the repository formatter; PowerShell `utf8NoBOM` incompatibility was avoided with `git format-patch -o`; a wrong `runtime.json` assumption was corrected to `orca-runtime.json`; sandboxed CIM access and Git fetch writes were rerun with narrowly scoped approval. None is evidence of product recovery by itself.

## 2026-08-25 upstream freshness and D1 verification

`origin/main` advanced by 26 commits while A1 through D1 were local. The six independent commits
were rebased in order instead of being squashed. C1 conflicted once in
`src/main/runtime/orca-runtime.ts`: upstream added `terminalStatusPayloadMatchesHook` at the same
import boundary where C1 added `observeParentLoss`. Both imports were retained. The repository's
named `resolving-merge-conflicts` skill was not available in the active skill inventory, so the
resolution was verified by the full runtime suite and typecheck rather than claimed from tool use.

The first attempt to stage the resolved file failed twice with `.git/index.lock: Permission denied`.
No lock file existed; many long-lived Git processes were observable. A narrowly approved `git add`
outside the restricted filesystem boundary succeeded, and rebase then completed. No process was
terminated and no stash, reset, or skipped commit was used.

The first post-rebase full runtime run failed 5 of 1,198 tests. Upstream exact-equality fixtures did
not yet name C1's three default projection fields (`parentStatus`, `inputPolicy`, `rebindStatus`) for
two missing/mismatched Run cases, one completed Dispatch, and two settled Dispatch states. The
fixtures were updated to assert the actual contract; the focused patterns passed 9/9 and the full
runtime file then passed 1,192/1,192. Product state derivation was not weakened.

Post-rebase receipts on Node `v24.15.0`: combined D1/C1/B1/CLI tests passed 116/116; C2 checkpoint,
reset, and v29-to-v30 migration tests passed 6/6; full runtime passed 1,192/1,192; canonical full
typecheck exited 0. Windows bootstrap diagnostics passed 11 tests and skipped 17 because
`runtime-client.test.ts` is platform-skipped on Windows. Those skips are explicit platform coverage
gaps, not a full Windows verification claim.

One bounded PowerShell search used the POSIX-style `docs/reference/*.md` argument and failed with
Windows error 123. Re-running `rg` against the directory succeeded. The failed lookup changed no
files and was not treated as product evidence.

The first final formatting check found only the new code-map revision table misaligned. The
repository formatter was applied to the named documentation set, followed by a clean check; no
source semantics changed.

The commit-time freshness fetch then found one additional upstream workspace-cleanup commit, moving
the branch to 1 behind / 6 ahead after the first verification run. Receipts were committed before a
second six-commit rebase. That rebase completed without conflict. Its 48 changed upstream paths were
all in workspace-cleanup and i18n surfaces, with no overlap with A1 through D1; targeted contracts
and typecheck were nevertheless rerun before the final amend. The seven-file A/B/C/D suite passed
119/119, parent-loss runtime projection patterns passed 10/10, and canonical full typecheck exited 0.

The first attempt to update the second-rebase SHA table used pre-formatter Markdown spacing and
failed atomically during patch context verification. The current formatted rows were read and an
exact patch was applied; no partial documentation edit occurred.

A subsequent final fetch observed three more upstream commits and again changed freshness from
0 behind to 3 behind. They affected crash reporting, sidebar activity status, and popover behavior;
none touched the A1-D1 paths. A third six-commit rebase completed without conflict and restored
0 behind / 6 ahead. Core A/B/C/D contracts passed 119/119 and canonical full typecheck exited 0 on
that base.
