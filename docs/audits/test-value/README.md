# Comprehensive test-value audit

Goal: read every test body, decide whether to keep, remove, consolidate or fix it, and validate each change against the behavior it protects. The audit is **in progress**.

[`progress.json`](./progress.json) reports current counts by area. [`inventory.jsonl`](./inventory.jsonl) lists candidate files with content hashes, discovery signals and review status. Scanning a file does not count as reviewing it. All cases in an unreviewed file remain pending.

## Discovery and completion

Run from the repository root after installing dependencies:

```sh
node docs/audits/test-value/refresh.mjs
```

The inventory scans tracked source files, reuses CI's unit-file discovery, parses JavaScript/TypeScript test declarations, and looks for native-language declarations, test filenames, test/support directories, regressions, reproductions, smoke checks and benchmarks. Named suites remain candidates even when the parser finds no declarations. Support files and reproduction scripts need manual classification; the file count is not a count of runnable suites.

Declaration counts are static hints: a parameterized declaration counts once, and custom factories or standalone assertions may have no recognized declarations. Reviewers must read the complete file, its tables/factories and relevant production paths, and record additional cases the parser misses. Discovery patterns must be extended when an unfamiliar runner is found. Final reconciliation must also check runner configurations and workflow/package entrypoints for omitted scripts. The initial inventory does not establish exhaustive completion.

A file is `reviewed` only when it has evidence, individual case decisions and a matching final SHA-256. Changed content becomes `stale`. Original hashes and source commits preserve decisions for removed/consolidated cases; the refresh command checks original hashes and rejects missing decisions for recognized original declarations. Generated files never promote pending candidates automatically.

Completion requires no unreviewed or stale test files, no unresolved support/script classifications, decisions for every actual case (including parameter tables and inline tests), and validation of all changes. Previously merged cleanup PRs do not substitute for this review.

## Ownership

| Area                                                       | Reviewer       | Next batch                           |
| ---------------------------------------------------------- | -------------- | ------------------------------------ |
| `cloud/`                                                   | `audit_cloud`  | Reconciled at batch 6 checkpoint     |
| `src/main/`                                                | `audit_cloud`  | Continue after `main-0003-first10`   |
| `config/`                                                  | `audit_config` | Continue after `config-0009-first10` |
| `mobile/`                                                  | `audit_mobile` | Continue after `mobile-0008-first10` |
| Remaining `src/`, `native/`, `tests/`, `.github/`, `docs/` | root           | Continue after `root-0082`           |

Ownership is disjoint. Within an area, continue in tracked path order after the last batch; explicitly include nonstandard/inline cases and support candidates before closing the area.

## Review records

Each `reviews/<area>-<batch>.jsonl` row records the original path/hash/commit, final reviewed hash, reviewer, decision, rationale, production evidence, and case-level line/title/decision/reason. Lines and titles refer to the original source. New or changed assertions are explained in the corresponding case decision. Files with no test cases require an explicit classification and rationale rather than invented cases.

Batch validation lives in `reviews/<area>-<batch>-validation.json`. Local log paths identify session evidence; recorded commands/results and regression descriptions survive outside that session. A production mutation is temporary, must fail the retained tests and must be restored before committing. Mutations are targeted evidence, not a substitute for reviewing every case.

## Batches

[PR #32269](https://github.com/stablyai/orca/pull/32269) merged the first 105 reviewed files and 720 original declarations, removing 467 net test lines. Its full PR aggregate and all other checks passed; squash commit `bc99add2897d1e9a77da44630d11eaff5cf81249`.

[PR #32305](https://github.com/stablyai/orca/pull/32305) merged another 210 original files and 1,482 case records, removing 324 net test lines. All required checks and the full PR aggregate passed; squash commit `92dfb4fda69e746e96786ea7af417813ac441394`.

[PR #32353](https://github.com/stablyai/orca/pull/32353) merged another 180 original files and 1,188 case records, plus one re-review after upstream changes. Its 70 changed test files removed 318 net test lines. The full PR aggregate and all other checks passed; squash commit `8f6283b32bcdefa746613e4c28d04bb1fe954eb9`.

[PR #32426](https://github.com/stablyai/orca/pull/32426) merged another 204 original files and 1,104 case records, plus one upstream re-review with nine records and 83 separately enumerated mobile auxiliary controls. Its 42 changed test/support files removed 153 net lines. Required-check discovery reported no configured checks; the full PR aggregate passed with no failed checks. Squash commit `89b3d382847f10b31a731ebd7e18aad022a4b15a`.

[PR #32498](https://github.com/stablyai/orca/pull/32498) merged another 184 original files and 1,692 case records, plus four separately enumerated mobile fixture controls and two supplemental Cloud tooling-manifest reviews. Its 59 changed test/support files removed 60 net lines. All checks and the full PR aggregate passed; squash commit `5d32f372e76983b6436d5700ce688990662e7243`. One superseding review covered all 12 current unit-selection declarations (25 expanded cases) after an upstream change.

[PR #32576](https://github.com/stablyai/orca/pull/32576) merged another 150 original files and 1,228 case records, plus two Cloud manifest re-reviews and two upstream CI re-reviews with 20 case records and 93 explicit parameter inputs. Its 82 changed test/support files removed 625 net lines, including four obsolete benchmarks and two private mobile suites whose distinct controls transferred into passing actual-host/public-reader cases. Mobile separately records 315 domain rows and 15 runtime traversal policies; config records 182 explicit controls and 536 input occurrences. Its full PR aggregate and all applicable checks passed; squash commit `633da07af5f82659641870677753d378c1ee5c65`.

[PR #32681](https://github.com/stablyai/orca/pull/32681) merged another 117 original files and 767 case records, plus upstream re-reviews. Its full PR aggregate and all applicable checks passed; squash commit `9b6a2e8ff1fe97701a40995cd26e019da3af3f2c`.

[PR #32777](https://github.com/stablyai/orca/pull/32777) merged another 171 original files and 1,256 case records, plus the graph re-review. Its full PR aggregate and all applicable checks passed; squash commit `d91a3d5804b20251dbdcee2640f1c92ed98d2fe4`.

The current batch adds 40 original files and 412 case records: ten CLI files, ten main-process suites, ten config test/support files and ten mobile suites. The decisions retain 308 cases, fix 91, consolidate ten and remove three, leaving 400 declarations. Changes exercise actual generated hooks and mobile manifest readers, require exact CLI output and refusals, repair a noncausal dependency fixture, and consolidate duplicate aggregate scenarios. One orphan support file is removed. Local runs pass 517 cases with two Windows-only cases skipped on Linux. Source review counts are not runtime test totals.

At this checkpoint, 1,347 present files are reviewed, 16 are removed, none are stale and 15,623 candidates remain pending. The remaining 40 paths in each agent's larger assignment are excluded from this batch. Cloud runner/workflow mapping is reconciled at its pinned checkpoint; repository-wide reconciliation and the remaining candidates are still required.

Further completed review records:

| Batch                  |             Files | Case records | Main decisions                                                                                                                   |
| ---------------------- | ----------------: | -----------: | -------------------------------------------------------------------------------------------------------------------------------- |
| `root-0001`            |                14 |          101 | Repair observer reset/readiness; trim allocator and environment-only checks.                                                     |
| `root-0002`            |                20 |           87 | Exercise installed link callbacks; consolidate cache checks; remove a conditional no-op test.                                    |
| `root-0003`            |                 6 |           40 | Classify Windows fixtures and standalone cases; retain native clipboard integration; trim exact traversal counts.                |
| `root-0004`            |                15 |          101 | Remove source-string and capability-only checks; observe pacing in actual mouse delivery.                                        |
| `root-0005`            |                 4 |           32 | Retain real Windows argument, filesystem and delayed tree-termination boundaries.                                                |
| `root-0006`            |                 1 |           14 | Retain storage lease ownership, generation conflicts and clock-driven credential caching.                                        |
| `mobile-0002`          |                50 |          283 | Consolidate repeated mounts and inventories; fix action routing and deferred SSH assertions.                                     |
| `config-0002`          |                50 |          375 | Trim copied policies; fix vacuous assertions and nested Bash fixture isolation.                                                  |
| `cloud-0002`           |                50 |          449 | Use independent authorization inputs and durable phone state; observe scoped locks and clean migration fixtures.                 |
| `root-0007`            |                 3 |           22 | Trim action/docs inventories; test actual hostile formatter inputs under a VM deadline.                                          |
| `root-0008`            |                 5 |            5 | Classify filesystem, socket and task retention proofs; distinguish measurements from assertions.                                 |
| `root-0009`            |                 5 |            6 | Preserve archived browser lifecycle and source-graph proofs with explicit drift limits.                                          |
| `root-0010`            |                 4 |            6 | Preserve actual Monaco/store lifetime proof and its dependency/source fences.                                                    |
| `root-0011`            |                 2 |           10 | Correct a chunk-size test's memory claim; classify the historical history-window driver.                                         |
| `root-0012`            |                 8 |           96 | Preserve independent full-reader oracle and every manual parity/growth/allocation/verifier control.                              |
| `root-0013`            |       1 re-review |            7 | Recheck the upstream compiler-gate change; all seven actual build cases pass.                                                    |
| `mobile-0003`          |                50 |          315 | Remove copied inventories; exercise real editor fallback, discard target and hardware-back delivery.                             |
| `config-0003`          |                50 |          328 | Use actual file matching, generated versions and Git checkout bytes; require real GC/canvas paths.                               |
| `cloud-0003`           |                53 |          400 | Exercise batch renewal, actual replay/SQL, scoped locks, pagination and deterministic transaction errors.                        |
| `root-0014`            |                 2 |           23 | Classify acknowledged retirement and distinguish memory rollback from disk-failure evidence.                                     |
| `root-0015`            |                 3 |           11 | Preserve prompt-retention groups and historical source fences; count WeakRefs as objects.                                        |
| `root-0016`            |                 2 |           50 | Review Crashpad parity cases and driver controls with explicit package/source drift limits.                                      |
| `root-0017`            |                 1 |            8 | Classify daemon late-exit scenarios across both historical variants.                                                             |
| `root-0018`            |                 4 |           40 | Review shared-owner lifecycle cycles and fixed-source guards.                                                                    |
| `root-0019`            |                 1 |            3 | Reproduce current real loopback stream pause, drain and unpause behavior.                                                        |
| `root-0020`            |                 4 |           23 | Classify empty-delta controls and archived dependency fences.                                                                    |
| `root-0021`            |                 2 |           12 | Retain GitLab known-host behavior with explicit reversepatch drift limits.                                                       |
| `root-0022`            |                 1 |            2 | Classify hydration phases against the retired source boundary.                                                                   |
| `root-0023`            |                 1 |            2 | Classify legacy-import phases and baseline-transform rejection.                                                                  |
| `root-0024`            |                 1 |            2 | Preserve log-tail proof phases and reversepatch guard evidence.                                                                  |
| `root-0025`            |                 4 |           12 | Review native PTY environment fixtures without overwriting historical reports.                                                   |
| `root-0026`            |                 1 |            6 | Classify nested-repository controls and the historical process-runner limit.                                                     |
| `root-0027`            |                 4 |          149 | Enumerate OSC133 memory, parity and driver controls with scanner drift limits.                                                   |
| `root-0028`            |                 2 |            5 | Review pending runtime-close incarnations through real host close with controlled ports.                                         |
| `root-0029`            |                 2 |            6 | Review split-close daemon socket/history-lock scenarios and loader fences.                                                       |
| `root-0030`            |                 5 |            9 | Review plugin-uninstall scenarios, loaders and measured WeakRef limits.                                                          |
| `root-0031`            |                 3 |           47 | Enumerate plugin-worker output variants and parity/CRLF controls.                                                                |
| `root-0032`            |                 1 |           12 | Run all current PTY-detector behavior combinations; report heap measurements separately.                                         |
| `root-0033`            |                 3 |           21 | Classify queued-graph generated cases, real socket/store fixture and retired module.                                             |
| `root-0034`            |                 1 |           16 | Classify retained-text measurements without inventing parity/cap/heap assertions.                                                |
| `root-0035`            |                 5 |           22 | Review RPC queue lifetime/resolver controls while preserving historical reports.                                                 |
| `root-0036`            |                 1 |            3 | Reproduce 1,000-request late-cancellation cleanup in the current VM proof.                                                       |
| `root-0037`            |       1 re-review |            9 | Recheck upstream conservative import resolution; all 22 expanded tests pass.                                                     |
| `cloud-0004`           |                50 |          347 | Exercise commit revalidation, refreshed leases, scoped locks and deterministic telemetry; trim copied SQL.                       |
| `config-0004`          |                50 |           33 | Keep the archive present for dependency protection; validate real benchmark routing and committed rows.                          |
| `mobile-0004`          |                50 |          240 | Await real delayed SSH/hydration and media replies; trim copied native/schema inventories.                                       |
| `root-0038–0050`       |                27 |          268 | Classify historical proofs, fixtures and source fences; run current session-search writer retention proof.                       |
| `root-0051`            |                 4 |           53 | Trim copied aliases; retain discovery commands and sanitized host/transcript values.                                             |
| `root-0052`            |                 4 |           63 | Verify automation hosts within identified rows and retain legacy output.                                                         |
| `root-0053`            |                 6 |           96 | Keep browser dispatch/version boundaries; verify actual ordered paging identities.                                               |
| `root-0054`            |                 3 |          363 | Trim duplicate suggestions; independently enumerate registry aliases.                                                            |
| `cloud-0005`           |                40 |          346 | Observe automatic flush and actual blackbox timing; retain durable eviction identities and independent proof bytes.              |
| `config-0005`          |                50 |          201 | Execute actual watchdog and localization shell; trim copied inventories and optional no-op case.                                 |
| `config-0005-rereview` |       1 re-review |           12 | Retain full selection for shared runtime inputs and current conservative planning boundaries.                                    |
| `mobile-0005`          |                50 |          302 | Hold real stale callbacks, stage media bytes before disconnect and verify deferred action delivery.                              |
| `root-0055–0065`       |                34 |          458 | Verify exact quoting, exported bytes, offline admission, dispatch identities and independent shutdown deadlines.                 |
| `config-0006`          |                52 |          203 | Replace copied browser controls with real clipboard, held-press and editor disposal; remove four obsolete benchmarks.            |
| `config-0006-rereview` |      2 re-reviews |           20 | Retain current cache sharing across runner pools and every conservative TypeScript input-consumer row.                           |
| `mobile-0006`          |                51 |          566 | Exercise initialized host admission, occupancy, audio races and chunk refusal; transfer private controls before deletion.        |
| `cloud-0006`           | 13 + 2 re-reviews |            0 | Reconcile package, runner, workflow, fixture provenance and inline smoke controls without inventing runtime passes.              |
| `root-0066–0071`       |                16 |          146 | Observe real CLI receipts, preserve request identities, enforce retry budgets and isolate headless recovery admission.           |
| `main-0001`            |                51 |          311 | Exercise ACP lifecycle and cleanup boundaries; transfer duplicate recording controls and independently check response data.      |
| `config-0007`          |                50 |          310 | Observe actual mobile web actions, evaluate CI admission conditions and retain independent asset and serializer oracles.         |
| `upstream-0001–0005`   |  46 + 1 re-review |          483 | Recheck comment-only CLI changes; evaluate cache admission, require named Windows build steps and observe exact capped output.   |
| `root-0072–0078`       |                21 |          163 | Require structured CLI errors and exact request identities; observe actual host replies before acknowledgement.                  |
| `main-0002`            |                50 |          337 | Exercise ACP replay and lifecycle, child cleanup, hook delivery and independent observer timing.                                 |
| `config-0008`          |                50 |          257 | Evaluate workflow gates, reseal failures and all compiler-key inputs; trim redundant inventory checks.                           |
| `mobile-0007`          |                50 |          499 | Exercise actual root detach, byte-window flow, bundle staging/activation and cache-independent failure retention.                |
| `upstream-0006`        |       1 re-review |            9 | Retain exact graph/opacity collections after additive ownership metadata; all 22 expanded cases pass.                            |
| `root-0079–0082`       |                10 |           96 | Require exact CLI identities, output and typed refusals; restore failure status safely.                                          |
| `main-0003-first10`    |                10 |          101 | Execute generated hooks and spool filtering; enforce telemetry, timeout, PATH, cache and staged-write boundaries.                |
| `config-0009-first10`  |                10 |          113 | Repair causal import ownership and independent preflight expectations; consolidate 154 duplicate scenarios and remove an orphan. |
| `mobile-0008-first10`  |                10 |          102 | Exercise actual manifest and strict bridge readers; retain exact storage entries and host-removal no-write behavior.             |

Two production findings are recorded in `reviews/cloud-0005-validation.json`: audit rows added after `stop()` can still persist at the batch threshold, and queue overflow during an in-flight reserve-ledger insert can lose a queued identity. That batch reproduced and recorded them without changing production behavior. Cloud-only relay test/typecheck/lint build the unchanged process-host package before resolving its compiled exports; this prerequisite was validated with generated outputs absent.

Archived proofs retain historical source/dependency fences. A drift rejection is recorded as a limitation, never as a current-head test pass. Permanent suites read only as supporting evidence remain pending unless they have their own completed review.

Validation commands, results and platform limits live in each batch's validation JSON. The macOS changes require the native Swift CI job; local Linux runs cannot establish that result. Standalone Windows cases are explicitly enumerated even when the static parser finds no declarations. Fixture/support classifications have no invented runnable cases. All remaining candidates stay pending, and broad discovery still requires final runner/entrypoint reconciliation.

`docs/**` is ignored in this repository. Add audit artifacts explicitly with `git add -f`, and stage only completed batches.
