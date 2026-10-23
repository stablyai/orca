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

| Area                                             | Reviewer                 | Next batch    |
| ------------------------------------------------ | ------------------------ | ------------- |
| `cloud/`                                         | `audit_cloud`            | `cloud-0002`  |
| `config/`                                        | `audit_config`           | `config-0002` |
| `mobile/`                                        | `audit_mobile`           | `mobile-0002` |
| `src/`, `native/`, `tests/`, `.github/`, `docs/` | root; pending assignment | Pending       |

Ownership is disjoint. Within an area, continue in tracked path order after the last batch; explicitly include nonstandard/inline cases and support candidates before closing the area.

## Review records

Each `reviews/<area>-<batch>.jsonl` row records the original path/hash/commit, final reviewed hash, reviewer, decision, rationale, production evidence, and case-level line/title/decision/reason. Lines and titles refer to the original source. New or changed assertions are explained in the corresponding case decision. Files with no test cases require an explicit classification and rationale rather than invented cases.

Batch validation lives in `reviews/<area>-<batch>-validation.json`. Local log paths identify session evidence; recorded commands/results and regression descriptions survive outside that session. A production mutation is temporary, must fail the retained tests and must be restored before committing. Mutations are targeted evidence, not a substitute for reviewing every case.

Initial batch: 105 files, 720 original declarations; 22 changed test files, 467 net lines removed. Validation: 256 mobile tests, 196 push tests with PostgreSQL, 180 with SQLite (16 intentional PostgreSQL-only skips), 11 desktop proof tests, and 113 config tests passed. Nine targeted mutations were caught. Production files were restored. PR/check/merge references will be added as batches land.

`docs/**` is ignored in this repository. Add audit artifacts explicitly with `git add -f`, and stage only completed batches.
