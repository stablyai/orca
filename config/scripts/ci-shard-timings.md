# Timing-based CI shards

The eight unit shards and fourteen general E2E shards use longest-processing-time
assignment of whole files to the currently lightest shard. Ties use file path and
then shard index, independent of filesystem enumeration and locale. Unknown,
zero, or invalid durations use the baseline's positive median (1 second when no
positive evidence exists). Deleted files never enter discovery. Unit weights
include measured environment startup, preparation, setup, imports and test execution;
no uniform overhead is added.

Unit assignment runs inside Vitest's sequencer after discovery and CLI exclusions;
Vitest's default sort, workers and isolation remain intact. It is enabled only by
`ORCA_BALANCE_UNIT_SHARDS=1`; ordinary local runs and explicit file filters retain
their existing behavior. E2E uses Playwright's native `--list` and `--test-list`,
retaining project filters, skipped tests and complete serial groups within files.
The workflow verifies selected test IDs against full discovery before executing.
Dedicated SSH, native IME, WSL and first-paint lanes are unchanged.

## Evidence and limits

`ci-shard-timings.json` records source runs. Unit report provenance and contributing
job IDs for the current refresh appear below; E2E job IDs remain in the JSON.

- Original unit run **34675583768**, Node 24, all eight successful shards: 8,484 completed
  file durations. The summed transform/setup/import/environment durations divided
  by measured file count give a rounded-up **526ms** per-file overhead allowance.
  The original shard weighted loads were **764–849 worker-seconds**, versus
  **792–792** after balancing the identical measured files. File counts change
  from **1,056–1,065** to **1,060–1,061**.
- General E2E run **34652504501**, all fourteen shard logs: 291 files with completed
  headless test durations, including failures. Headful benchmark reruns are not
  counted. Original completed test loads were **540–1,727 seconds**, versus
  **1,083–1,093** after whole-file balancing on the same measured files. The longest
  measured file is **528 seconds**, below the balanced shard load.
- Original checkout discovery at validation contained **8,553 unit files** after the
  workflow's exact exclusions and **733 headless E2E tests in 340 files**. New and
  unmeasured files remain selected. Projected current loads were about **797
  worker-seconds** per unit shard (1,068–1,070 files) and **1,190–1,200 seconds** per
  E2E shard (22–25 files).

These are scheduling projections, not measured post-change wall-clock gains.
Unit durations overlap across workers. The original average overhead has now been
replaced by per-file module measurements. E2E evidence includes failed shards and can omit
unfinished tests; unknowns receive a deterministic estimate. Historical timings
age as specs change. Full CI runs on the existing runner classes are required to
measure elapsed-time and occupancy improvements, including discovery overhead.
No retries, assertions, coverage exclusions, runner classes or shard counts changed.

## Unit refresh: September 26, 2026

The current baseline imports all eight successful unit shards from
[run 36221874572, attempt 1](https://github.com/stablyai/orca/actions/runs/36221874572/attempts/1).
They ran Node **24.21.0** on `ubuntu-latest` with Vitest's default Linux worker
count and isolation. The checked-out merge was
`f68ecf8c4aeb396795a8f0f9dbd8ef58fd634d43`, whose second parent is the run's PR
head `5a26cfa83d7542f9f4545b7a7c4c4174ff213b18`. The workflow failed in another
lane; every contributing unit job and test step succeeded. No failed reports or
four-worker trial measurements contributed.

| Shard | Job ID       | Completed files | Measured worker-seconds | Test step seconds | Job seconds |
| ----- | ------------ | --------------- | ----------------------- | ----------------- | ----------- |
| 1     | 108348885240 | 1,209           | 1,019.941               | 420               | 446         |
| 2     | 108348885231 | 1,210           | 1,000.547               | 413               | 447         |
| 3     | 108348885289 | 1,211           | 933.332                 | 386               | 419         |
| 4     | 108348885241 | 1,211           | 1,022.838               | 418               | 453         |
| 5     | 108348885283 | 1,211           | 1,016.000               | 417               | 448         |
| 6     | 108348885237 | 1,211           | 980.988                 | 407               | 440         |
| 7     | 108348885275 | 1,210           | 810.367                 | 326               | 355         |
| 8     | 108348885261 | 1,210           | 973.722                 | 407               | 445         |

All reports have `status: passed`, zero unhandled errors and identical source,
run, attempt, Node version and shard count. Each report's file keys exactly match
its selected assignment; all eight assignments describe the same plan, with no
missing or duplicate files across **9,683** measurements. Replaying the old
baseline reproduces that complete plan. Its SHA-256 is
`9042d8f1d2420b301ee5d9e56d768ad7d38530897dce0d641f362333aa194ad8`.
The importer sets overhead to zero; the E2E baseline is unchanged.

Discovery at checkout `80ff6c4e3e66de46e41c75856fd1fb6d77d515de`, using the unit
workflow's exact exclusions, contains **9,732 files**. All 9,683 measurements
still apply; the **49** unmeasured files receive the new **230ms** median. Both
plans select every current file exactly once. To compare assignments fairly,
the following loads evaluate both plans using the same new measurements and
fallback, rather than comparing two different timing metrics:

| Current discovery projection | Previous assignment | Refreshed assignment  |
| ---------------------------- | ------------------- | --------------------- |
| Files per shard              | 1,216–1,217         | 1,215–1,217           |
| Worker-seconds per shard     | 816.045–1,049.604   | 971.124–971.126       |
| Largest load                 | 1,049.604           | 971.126 (7.48% lower) |

The combined projected work is unchanged at **7,769.005 worker-seconds**.
Reassignment redistributes measured work; it does not itself reduce test work.
These are projections from one successful unit run, not a measured wall-clock
improvement. The source test steps took **326–420 seconds**, totaling **3,194
seconds (53.233 runner-minutes)**. Full unit jobs took **355–453 seconds**, totaling
**3,453 seconds (57.550 runner-minutes)**. These durations exclude queue time;
hosted before/after runs are needed to measure the refreshed assignment's elapsed
time and occupancy.

## Reproduction and refresh

Every shard uploads an artifact named with its shard, Node version where relevant,
and run attempt. `assignment.json` contains the checked-out source SHA, run ID,
attempt, baseline SHA-256, algorithm, fallback, all shard files and chosen shard.
E2E also retains both discovery reports and `selected.txt`. Artifacts live for
14 days. A rerun of the same source uses the same checked-in baseline rather than
mutable timing caches; a GitHub job rerun therefore keeps its assignment.

Unit artifacts also contain `unit-timings.json`, measured through Vitest's reporter
API. Each file's weight includes environment startup, test harness preparation,
setup files, imports and test execution. Imports are often more expensive than the
assertions: run **36212793136**, shard 4, spent **535 worker-seconds importing**
and **357 running tests**. The refreshed baseline replaces the old uniform import
allowance with the complete successful measurements described above.

For E2E reproduction, check out the recorded source and pass the saved list to the
existing command: `pnpm run test:e2e --test-list=/path/to/selected.txt` with the same
CI environment/build inputs. For unit reproduction, use the unchanged workflow
command and exclusions with `ORCA_BALANCE_UNIT_SHARDS=1` and the recorded
`--shard=INDEX/8`. Direct test-file reruns remain supported.

To refresh unit weights, download all `unit-shard-node-*` artifacts from one
complete successful unit shard set, run attempt and Node version into a directory,
preserving their shard subdirectories. An unrelated workflow lane may fail;
every contributing unit job and report must pass. Check the attempt-specific jobs
API, source workflow/config, report provenance and exact file coverage against the
saved assignments, then run:

```sh
node config/scripts/ci-unit-timing-import.mjs ARTIFACT_DIRECTORY config/scripts/ci-shard-timings.json
```

The importer rejects missing or duplicate shards, duplicate files, failed unit reports,
unhandled errors and mixed source revisions, run attempts or Node versions. It
preserves E2E weights and sets unit overhead to zero because the per-file measurements
already include it. Timing artifacts remain diagnostic; failed or interrupted unit runs
are retained for investigation but cannot replace the scheduling baseline.

For older unit runs without reporter artifacts, and E2E refreshes, download
`log-JOB_ID.txt` files into one directory from
exactly one eight-shard unit run and one fourteen-shard general E2E run. Use the
job IDs from the Actions jobs API and fetch each with
`gh api repos/stablyai/orca/actions/jobs/JOB_ID/logs`. Do not include dedicated
lanes or multiple attempts. Then run:

```sh
node config/scripts/ci-shard-timing-import.mjs LOG_DIRECTORY UNIT_RUN_ID E2E_RUN_ID config/scripts/ci-shard-timings.json
```

The initial source logs are in `/tmp/orca-ci-shard-logs`; two were reused from
`/tmp/orca-ci-audit`, and the remaining twenty were fetched read-only. Reimporting
those logs reproduced the original baseline byte-for-byte. Review file-count and
load projections before adopting a new baseline; no network access is needed to
plan or run shards.

## Validation

- 74 focused tests passed across the two new test files and existing PR
  parallelism, E2E gate and release E2E dispatch contracts.
- The pinned Playwright CLI selected the real 733-test suite across all fourteen
  saved test lists with exact-once identity coverage and no missing tests.
- A temporary native Playwright fixture checks fourteen shards, serial groups,
  skipped cases, headful filtering and mismatch rejection without launching UI.
- Real Vitest discovery with all workflow exclusions yielded 8,553 files; the
  sequencer's eight assignments covered each exactly once. An actual opt-in
  Vitest shard executed successfully and persisted its manifest.
- Focused TypeScript checking of `config/vitest.config.ts` and imported modules,
  oxlint, formatting and baseline reimport checks passed.
- The September 26 refresh matched all eight reports to their saved assignments,
  checked successful attempt-specific job results and source worker settings,
  reproduced the old assignment, and preserved the E2E baseline exactly. All 12
  importer/reporter and shard-assignment tests passed; importing the artifacts
  reproduced the refreshed JSON byte-for-byte.

All local tests used `ORCA_BACKGROUND_LAUNCH=1` in background tool sessions. No app
windows or full E2E test bodies were launched.
