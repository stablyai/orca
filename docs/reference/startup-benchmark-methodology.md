# Measuring a startup change without measuring the machine

Comparing two `startup-time-bench.mjs` runs by their medians does not tell you what a startup change did. Developer machines drift over the length of a run — thermal throttling, background indexers, page-cache warmth — and a blocked design (all baseline launches, then all candidate launches) charges that drift entirely to whichever arm ran second. Use `startup-ab-bench.mjs` for any before/after claim; keep `startup-time-bench.mjs` for profiling a single build.

## Quick path

1. Build each arm once, in its own worktree with its own `node_modules`:

   ```bash
   git worktree add --detach ../orca-arm-baseline <baseline-commit>
   (cd ../orca-arm-baseline && pnpm install --frozen-lockfile && pnpm build:electron-vite)
   git worktree add --detach ../orca-arm-candidate <candidate-branch>
   (cd ../orca-arm-candidate && pnpm install --frozen-lockfile && pnpm build:electron-vite)
   ```

   Give each arm its own dependency tree rather than copying `out/` next to a shared one. Arms that share `node_modules` both run whatever was installed last, so a lockfile or externalized-module difference between the two refs gets measured as if it were the change under test.

2. Run the interleaved benchmark:

   ```bash
   node tools/benchmarks/startup-ab-bench.mjs --label my-change \
     --baseline-app-dir ../orca-arm-baseline \
     --candidate-app-dir ../orca-arm-candidate \
     --pairs 12 --warmup 2
   ```

3. Read the drift-control block at the bottom **before** reading any phase verdict.

Raw milestone events are omitted from the result JSON — at realistic pair counts they are most of the file and a verdict is recomputed from the phases alone. Pass `--keep-events` when debugging a launch rather than comparing two builds.

## How to read the output

| Column | Meaning |
|---|---|
| baseline / candidate | Plain medians. Context only — never quote these as the result. |
| shift (HL) | Hodges-Lehmann estimate of the paired shift. Negative means the candidate got faster. |
| 95% CI | Seeded percentile-bootstrap interval. Reproducible from the raw JSON. |
| verdict | `improved` / `regressed` only when the whole interval sits on one side of zero; otherwise `inconclusive`. |

The run ends with a **drift control** block. It reports the same statistics for phases the change cannot plausibly affect (by default `spawnToAppReady`, `appReadyToServices`, `servicesToI18n` — all decided before the window loads), and the result JSON records the outcome as `measurementStatus`:

| `measurementStatus` | Meaning |
|---|---|
| `attributable` | At least one control phase was measured and none moved. The phase verdicts may be quoted. |
| `control-phase-drift` | A control phase showed a direction. The run measured the machine, not the change — re-run on an idle machine. |
| `controls-unmeasured` | No control phase produced data. Drift was not found absent, it was never measured. Pass `--control-phases` this profile actually reaches. |

Only `attributable` licenses a number. A control phase reporting `no-data` is not a quiet machine — it is a control that never fired, which is why it is listed separately rather than counted as agreement.

The JSON also records `completedLaunches` and a `launchOutcomes` breakdown. A run where no launch reached the awaited milestone exits non-zero rather than reporting an absent verdict: that is a broken harness or environment, not an inconclusive measurement.

### Reading a result file that pre-dates these fields

`measurementStatus`, `unmeasuredControlPhases`, `launchOutcomes`, and `completedLaunches` were added after some committed evidence was produced. Files without them — currently `results/startup-lazy-onboarding-ab-*.json` — carry only `driftDetected`, which the rule above deliberately does not accept as a substitute. Reconstruct the status by hand before quoting such a file: look up each name in its `controlPhases` inside `phaseSummaries` and confirm every one is present and not `no-data`. If they all are and `driftDetected` is `false`, the run is what `attributable` now means. If any control phase is missing or `no-data`, it is `controls-unmeasured` and no verdict in it was ever attributable. Regenerating is preferable when the numbers still matter.

## Design decisions

| Topic | Decision |
|---|---|
| Ordering | ABBA blocks — pair 0 is baseline-then-candidate, pair 1 is the reverse. A drift growing steadily across the run enters consecutive pairs with opposite sign and cancels out of the paired deltas. |
| Pair count | Must be even. Cancellation is exact only when both arms share the same mean launch slot; `--pairs 12` is a reasonable floor for a sub-second effect. |
| Warmup | The first launches of a session pay page-cache and fixture-walk costs no later launch repeats. `--warmup N` runs N discarded rounds, and a round warms **both** arms in alternating order — warming only one hands it a cache advantage the ABBA schedule cannot cancel. |
| Estimator | Hodges-Lehmann, not the mean: one unlucky launch (a multi-second stall) is common and would otherwise dominate. |
| Control phases | Override with `--control-phases` when testing main-process work — the defaults assume the change is downstream of the window load. |
| Incomplete pairs | A pair contributes nothing to a phase unless both arms reached it, so a launch that died early cannot bias the shift. |

## Checklist before quoting a number

- [ ] `measurementStatus` is `attributable` — not just "no warning printed".
- [ ] The phase verdict is `improved` or `regressed`, not `inconclusive`.
- [ ] The quoted figure is the shift and its interval, not the difference of the two medians.
- [ ] Both arms differ only by the change under test (check `git diff --stat <baseline> -- src`).
- [ ] The results JSON is attached to the PR; the interval can be recomputed from it.

## Running it in CI

`.github/workflows/startup-perf-ab.yml` runs the same comparison on a runner. It is dispatch-only on purpose: an A/B needs two refs somebody chose, so there is no daily number to trend. Give it a `baseline_ref` (usually the merge-base) and it builds both arms — each in its own worktree with its own `pnpm install` — runs the pairs under xvfb, and uploads the result JSON. An unusable run is reported as a workflow warning rather than a failure (the code is fine, the runner was not quiet), and the job withholds the phase table so an unproven verdict cannot be quoted from the log.

## Next step

The counterbalancing property is covered by `tools/benchmarks/interleaved-arm-schedule.test.mjs`, and the estimators by `tools/benchmarks/paired-shift-statistics.test.mjs`. Extend those rather than adjusting a threshold if a run looks wrong.
