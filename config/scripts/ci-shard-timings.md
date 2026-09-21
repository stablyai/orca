# Timing-based CI shards

The eight unit shards and fourteen general E2E shards use longest-processing-time
assignment of whole files to the currently lightest shard. Ties use file path and
then shard index, independent of filesystem enumeration and locale. Unknown,
zero, or invalid durations use the baseline's positive median (1 second when no
positive evidence exists). Deleted files never enter discovery. Unit weights add
526ms per file for measured transform/setup/import/environment overhead.

Unit assignment runs inside Vitest's sequencer after discovery and CLI exclusions;
Vitest's default sort, workers and isolation remain intact. It is enabled only by
`ORCA_BALANCE_UNIT_SHARDS=1`; ordinary local runs and explicit file filters retain
their existing behavior. E2E uses Playwright's native `--list` and `--test-list`,
retaining project filters, skipped tests and complete serial groups within files.
The workflow verifies selected test IDs against full discovery before executing.
Dedicated SSH, native IME, WSL and first-paint lanes are unchanged.

## Evidence and limits

`ci-shard-timings.json` records run IDs and every contributing job ID:

- Unit run **34675583768**, Node 24, all eight successful shards: 8,484 completed
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
- Current checkout discovery at validation contained **8,553 unit files** after the
  workflow's exact exclusions and **733 headless E2E tests in 340 files**. New and
  unmeasured files remain selected. Projected current loads were about **797
  worker-seconds** per unit shard (1,068–1,070 files) and **1,190–1,200 seconds** per
  E2E shard (22–25 files).

These are scheduling projections, not measured post-change wall-clock gains.
Unit durations overlap across workers and the overhead allowance is an average,
not a per-file import profile. E2E evidence includes failed shards and can omit
unfinished tests; unknowns receive a deterministic estimate. Historical timings
age as specs change. Full CI runs on the existing runner classes are required to
measure elapsed-time and occupancy improvements, including discovery overhead.
No retries, assertions, coverage exclusions, runner classes or shard counts changed.

## Reproduction and refresh

Every shard uploads an artifact named with its shard, Node version where relevant,
and run attempt. `assignment.json` contains the checked-out source SHA, run ID,
attempt, baseline SHA-256, algorithm, fallback, all shard files and chosen shard.
E2E also retains both discovery reports and `selected.txt`. Artifacts live for
14 days. A rerun of the same source uses the same checked-in baseline rather than
mutable timing caches; a GitHub job rerun therefore keeps its assignment.

For E2E reproduction, check out the recorded source and pass the saved list to the
existing command: `pnpm run test:e2e --test-list=/path/to/selected.txt` with the same
CI environment/build inputs. For unit reproduction, use the unchanged workflow
command and exclusions with `ORCA_BALANCE_UNIT_SHARDS=1` and the recorded
`--shard=INDEX/8`. Direct test-file reruns remain supported.

To refresh the baseline, download `log-JOB_ID.txt` files into one directory from
exactly one eight-shard unit run and one fourteen-shard general E2E run. Use the
job IDs from the Actions jobs API and fetch each with
`gh api repos/stablyai/orca/actions/jobs/JOB_ID/logs`. Do not include dedicated
lanes or multiple attempts. Then run:

```sh
node config/scripts/ci-shard-timing-import.mjs LOG_DIRECTORY UNIT_RUN_ID E2E_RUN_ID config/scripts/ci-shard-timings.json
```

The initial source logs are in `/tmp/orca-ci-shard-logs`; two were reused from
`/tmp/orca-ci-audit`, and the remaining twenty were fetched read-only. Reimporting
those logs reproduced the checked-in JSON byte-for-byte. Review file-count and
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

All local tests used `ORCA_BACKGROUND_LAUNCH=1` in background tool sessions. No app
windows or full E2E test bodies were launched.
