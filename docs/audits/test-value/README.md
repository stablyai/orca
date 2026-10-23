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

| Area                                             | Reviewer       | Next batch                 |
| ------------------------------------------------ | -------------- | -------------------------- |
| `cloud/`                                         | `audit_cloud`  | `cloud-0004`               |
| `config/`                                        | `audit_config` | `config-0004`              |
| `mobile/`                                        | `audit_mobile` | `mobile-0004`              |
| `src/`, `native/`, `tests/`, `.github/`, `docs/` | root           | Continue after `root-0013` |

Ownership is disjoint. Within an area, continue in tracked path order after the last batch; explicitly include nonstandard/inline cases and support candidates before closing the area.

## Review records

Each `reviews/<area>-<batch>.jsonl` row records the original path/hash/commit, final reviewed hash, reviewer, decision, rationale, production evidence, and case-level line/title/decision/reason. Lines and titles refer to the original source. New or changed assertions are explained in the corresponding case decision. Files with no test cases require an explicit classification and rationale rather than invented cases.

Batch validation lives in `reviews/<area>-<batch>-validation.json`. Local log paths identify session evidence; recorded commands/results and regression descriptions survive outside that session. A production mutation is temporary, must fail the retained tests and must be restored before committing. Mutations are targeted evidence, not a substitute for reviewing every case.

## Batches

[PR #32269](https://github.com/stablyai/orca/pull/32269) merged the first 105 reviewed files and 720 original declarations, removing 467 net test lines. Its full PR aggregate and all other checks passed; squash commit `bc99add2897d1e9a77da44630d11eaff5cf81249`.

[PR #32305](https://github.com/stablyai/orca/pull/32305) merged another 210 original files and 1,482 case records, removing 324 net test lines. All required checks and the full PR aggregate passed; squash commit `92dfb4fda69e746e96786ea7af417813ac441394`.

The next batch adds 180 original files and 1,188 case records, plus one re-review after upstream changes. Its 70 changed test files remove 318 net test lines. Case records include static declarations and explicitly classified manual controls; they are not runtime test totals.

Further completed review records:

| Batch         |       Files | Case records | Main decisions                                                                                                    |
| ------------- | ----------: | -----------: | ----------------------------------------------------------------------------------------------------------------- |
| `root-0001`   |          14 |          101 | Repair observer reset/readiness; trim allocator and environment-only checks.                                      |
| `root-0002`   |          20 |           87 | Exercise installed link callbacks; consolidate cache checks; remove a conditional no-op test.                     |
| `root-0003`   |           6 |           40 | Classify Windows fixtures and standalone cases; retain native clipboard integration; trim exact traversal counts. |
| `root-0004`   |          15 |          101 | Remove source-string and capability-only checks; observe pacing in actual mouse delivery.                         |
| `root-0005`   |           4 |           32 | Retain real Windows argument, filesystem and delayed tree-termination boundaries.                                 |
| `root-0006`   |           1 |           14 | Retain storage lease ownership, generation conflicts and clock-driven credential caching.                         |
| `mobile-0002` |          50 |          283 | Consolidate repeated mounts and inventories; fix action routing and deferred SSH assertions.                      |
| `config-0002` |          50 |          375 | Trim copied policies; fix vacuous assertions and nested Bash fixture isolation.                                   |
| `cloud-0002`  |          50 |          449 | Use independent authorization inputs and durable phone state; observe scoped locks and clean migration fixtures.  |
| `root-0007`   |           3 |           22 | Trim action/docs inventories; test actual hostile formatter inputs under a VM deadline.                           |
| `root-0008`   |           5 |            5 | Classify filesystem, socket and task retention proofs; distinguish measurements from assertions.                  |
| `root-0009`   |           5 |            6 | Preserve archived browser lifecycle and source-graph proofs with explicit drift limits.                           |
| `root-0010`   |           4 |            6 | Preserve actual Monaco/store lifetime proof and its dependency/source fences.                                     |
| `root-0011`   |           2 |           10 | Correct a chunk-size test's memory claim; classify the historical history-window driver.                          |
| `root-0012`   |           8 |           96 | Preserve independent full-reader oracle and every manual parity/growth/allocation/verifier control.               |
| `root-0013`   | 1 re-review |            7 | Recheck the upstream compiler-gate change; all seven actual build cases pass.                                     |
| `mobile-0003` |          50 |          315 | Remove copied inventories; exercise real editor fallback, discard target and hardware-back delivery.              |
| `config-0003` |          50 |          328 | Use actual file matching, generated versions and Git checkout bytes; require real GC/canvas paths.                |
| `cloud-0003`  |          53 |          400 | Exercise batch renewal, actual replay/SQL, scoped locks, pagination and deterministic transaction errors.         |

Archived proofs retain historical source/dependency fences. A drift rejection is recorded as a limitation, never as a current-head test pass. Permanent suites read only as supporting evidence remain pending unless they have their own completed review.

Validation commands, results and platform limits live in each batch's validation JSON. The macOS changes require the native Swift CI job; local Linux runs cannot establish that result. Standalone Windows cases are explicitly enumerated even when the static parser finds no declarations. Fixture/support classifications have no invented runnable cases. All remaining candidates stay pending, and broad discovery still requires final runner/entrypoint reconciliation.

`docs/**` is ignored in this repository. Add audit artifacts explicitly with `git add -f`, and stage only completed batches.
