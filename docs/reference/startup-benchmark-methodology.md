# Measuring a startup change without measuring the machine

Comparing two `startup-time-bench.mjs` runs by their medians does not tell you what a startup change did. Developer machines drift over the length of a run — thermal throttling, background indexers, page-cache warmth — and a blocked design (all baseline launches, then all candidate launches) charges that drift entirely to whichever arm ran second. Use `startup-ab-bench.mjs` for any before/after claim; keep `startup-time-bench.mjs` for profiling a single build.

## Quick path

1. Build each arm once, into its own directory under the repo (so Electron resolves `node_modules` upward):

   ```bash
   git checkout --detach <baseline-commit> && pnpm build:electron-vite
   cp -r out .bench-fixtures/arms/baseline/out && cp package.json .bench-fixtures/arms/baseline/
   git checkout <candidate-branch> && pnpm build:electron-vite
   cp -r out .bench-fixtures/arms/candidate/out && cp package.json .bench-fixtures/arms/candidate/
   ```

2. Run the interleaved benchmark:

   ```bash
   node tools/benchmarks/startup-ab-bench.mjs --label my-change \
     --baseline-app-dir .bench-fixtures/arms/baseline \
     --candidate-app-dir .bench-fixtures/arms/candidate \
     --pairs 12 --warmup 2
   ```

3. Read the drift-control line at the bottom **before** reading any phase verdict.

## How to read the output

| Column | Meaning |
|---|---|
| baseline / candidate | Plain medians. Context only — never quote these as the result. |
| shift (HL) | Hodges-Lehmann estimate of the paired shift. Negative means the candidate got faster. |
| 95% CI | Seeded percentile-bootstrap interval. Reproducible from the raw JSON. |
| verdict | `improved` / `regressed` only when the whole interval sits on one side of zero; otherwise `inconclusive`. |

The run ends with a **drift control** block. It reports the same statistics for phases the change cannot plausibly affect (by default `spawnToAppReady`, `appReadyToServices`, `servicesToI18n` — all decided before the window loads). If one of those shows a direction, the run measured the machine, not the change, and every verdict above it is unproven. Re-run on an idle machine rather than quoting the numbers.

## Design decisions

| Topic | Decision |
|---|---|
| Ordering | ABBA blocks — pair 0 is baseline-then-candidate, pair 1 is the reverse. A drift growing steadily across the run enters consecutive pairs with opposite sign and cancels out of the paired deltas. |
| Pair count | Must be even. Cancellation is exact only when both arms share the same mean launch slot; `--pairs 12` is a reasonable floor for a sub-second effect. |
| Warmup | The first launches of a session pay page-cache and fixture-walk costs no later launch repeats, and would land entirely in one arm. `--warmup` runs are discarded. |
| Estimator | Hodges-Lehmann, not the mean: one unlucky launch (a multi-second stall) is common and would otherwise dominate. |
| Control phases | Override with `--control-phases` when testing main-process work — the defaults assume the change is downstream of the window load. |
| Incomplete pairs | A pair contributes nothing to a phase unless both arms reached it, so a launch that died early cannot bias the shift. |

## Checklist before quoting a number

- [ ] The drift control reported no directional movement.
- [ ] The phase verdict is `improved` or `regressed`, not `inconclusive`.
- [ ] The quoted figure is the shift and its interval, not the difference of the two medians.
- [ ] Both arms differ only by the change under test (check `git diff --stat <baseline> -- src`).
- [ ] The results JSON is attached to the PR; the interval can be recomputed from it.

## Next step

The counterbalancing property is covered by `tools/benchmarks/interleaved-arm-schedule.test.mjs`, and the estimators by `tools/benchmarks/paired-shift-statistics.test.mjs`. Extend those rather than adjusting a threshold if a run looks wrong.
