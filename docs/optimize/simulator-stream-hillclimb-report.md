# Simulator-stream performance: bounded small-diff hill-climb

Historical bounded JPEG experiment. The later, wider codec-adoption decision and retained implementation are in the [final integration report](simulator-avcc-autonomous-report.md). The negative results below remain unchanged.

## Decision

Retain the original production implementation. Neither tested change delivered a repeatable freshness improvement within the approved resource limits. Two consecutive non-winners reached the stopping rule; adding more scheduling machinery without a measured opportunity would increase review burden without demonstrated benefit.

The lag is **not exclusively upstream**. Orca's 33 ms drop gate materially limits decoded-image cadence. Removing that limit improves freshness, but substantially increases JPEG IPC and decode work. The native macOS path and a portable encoded stream have different costs; the measurements do not establish a hard Electron rendering-platform ceiling.

Baseline: `4d4da6f49f9582e65abe95d5ccc9b02e87405ae2`. Branch: `optimize/simulator-stream-hillclimb`. No production code, dependencies, wire contracts, or permanent tests changed on that branch. This report is the retained change.

## Measurements and validity

The local benchmark exercises the production Node HTTP stream/parser, IPC registration, preload bridge, renderer hook, and an image element. It sends changing 1206 × 2622 JPEG70 illustrated photo-feed frames, approximately 271 KB each, with pixel-encoded sequence IDs. It is not captured device content or the entire Orca application.

Primary metric: p95 age of the last pixel-verified decoded image at each renderer animation tick. This measures decoded paint-readiness, **not physical presentation FPS, native display FPS, or input-to-photon latency**. Hidden-compositor PNGs independently verify image content, sequence, and geometry; their acknowledgement-paced sample rate is not display FPS.

Each reported experiment uses three alternating original/candidate pairs, median aggregation, and the same frozen benchmark/corpus. Selection uses approximately 58 Hz source delivery with bursts. A distinct cadence/content-phase holdout is used only for final confirmation, not hypothesis generation. Each run samples one second before streaming and 2.8 seconds of active streaming.

The benchmark covers one portrait iPhone-resolution surface. iPad-sized surfaces, rotation, remote links, mobile clients, and full-app visibility parking were not exercised; they remain required coverage for a future implementation. No changed platform contract is being shipped here.

All valid experiment and final runs passed the decoded/compositor pixel, motion, dimensions, geometry, source-completeness, clock, and hidden-window checks. Repeating one real JPEG deliberately failed integrity and moving-content checks, produced only one distinct image, and increased p95 age to 2665 ms. No blank/static-output shortcut qualifies.

Calibration corrections preceded approval: JPEG85 was oversized relative to the observed source; JPEG70 was calibrated before selection. macOS capture color management changed fixed CSS fiducial colors, so the benchmark explicitly forces sRGB rather than weakening correctness thresholds. The benchmark then passed three baseline runs. Two invalid calibration attempts are excluded from comparisons.

Runtime: macOS arm64, Electron 43.8.1, Chromium 150.0.7871.250, embedded Node 24.22.0. The executable is the existing installed 43.8.1 build, not the worktree's undownloaded 43.8.4 dependency. All launches used `ORCA_BACKGROUND_LAUNCH=1`, hidden windows, and no foreground activation or simulator input.

### Resource interpretation

CPU sums the dedicated Electron main, renderer, GPU, and utility processes; 100% is one core. It includes common observer work, including per-image pixel probes and compositor capture. It is not whole-Orca CPU or device-helper encoding cost. IPC Mbps counts JPEG payload bytes, not network traffic or message headers. Peak RSS is sampled aggregate working-set MB, may double-count shared mappings, and is not deduplicated physical memory. The controller/source process is reported separately and excluded from these CPU/RSS values.

Initial baseline CPU ranges were 6.20 active and 4.42 idle percentage points. Resource changes near these ranges require caution. In particular, idle is measured **before** streaming: its variation cannot show that changing a frame cap causes idle work. Unchanged-code final controls also exceed the one-point idle bound on holdout. The caps were not relaxed after seeing results; both rejected candidates independently fail on a much stronger freshness or active-CPU result.

## Experiments

Each reference below is the original implementation measured immediately alongside that candidate, not a shared baseline borrowed from another experiment.

| Variant                    | Decoded age p95, ms | Decoded updates/s | Active CPU, % | Peak RSS, MB | IPC payload, Mbps |
| -------------------------- | ------------------: | ----------------: | ------------: | -----------: | ----------------: |
| Reference for cap60        |                  34 |             28.93 |         72.08 |      1146.24 |             62.66 |
| One constant: cap60        |                  18 |             56.43 |        110.05 |      1220.56 |            125.32 |
| Reference for latest30     |                  35 |             28.57 |         70.48 |      1139.92 |             62.60 |
| Bounded latest30 scheduler |                  49 |             28.93 |         70.37 |      1142.28 |             63.41 |

- **cap60 — rejected.** Forecast: 20–45% lower decoded age from removing cadence aliasing, with CPU/IPC risk. Actual: 47.1% lower age, but +37.98 active CPU percentage points, a 52.7% increase, and approximately double IPC payload. Every paired active-CPU increase exceeded the approved +3-point bound. This is a small diff, not a lightweight optimization.
- **latest30 — rejected.** Forecast: uncertain 0–15% freshness gain; waiting could instead increase age. Actual: 40% older images, with no meaningful cadence or CPU improvement. The one-slot/one-timeout implementation preserves immediate first delivery, latest-only trailing delivery, error/stop/replacement cancellation, and no idle loop. Correct lifecycle behavior does not offset the freshness regression.
- **Renderer animation-tick coalescing — not run.** It was conditional on measured redundant same-tick work. Ordinary kept input was below display cadence, and no locating evidence justified adding another wait. This is not a claim that all renderer optimizations are impossible.

The existing gate drops arrivals inside `floor(1000 / 30)` after the last emitted frame and does not retain them. With roughly 18 ms source intervals, it can emit every other arrival rather than a smooth 30 fps. The trailing alternative avoids dropping a final quiet update but can wait on an already aging frame. Relevant source: [MJPEG pacing](../../src/main/emulator/mjpeg-frame-stream.ts), [IPC copies](../../src/main/ipc/emulator-frame-stream.ts), and [renderer Blob/state path](../../src/renderer/src/components/emulator-pane/use-emulator-frame-stream.ts).

Approved acceptance: repeatable improvement above 5%; active CPU no more than +3 percentage points, idle CPU +1 point, peak RSS +10%; bounded storage and lifecycle preservation. Search limits: four experiments maximum, one active hour, two wall hours, stop after two consecutive non-winners. No new dependencies, helper changes, codec migrations, or wire/API changes were approved.

## Original-to-final confirmation

No candidate was integrated. Three alternating pairs on selection and three on holdout re-measured the retained original source. Both sides have benchmark-target source SHA-256 `19ee419c1a8f9e523b4c769d14e9a084c319242425d566584015595b0129252c`. Differences below are sampling variation, **not an optimization or a code regression**.

| Workload  | Required metric     | Original | Retained | Observed difference | Relative difference |
| --------- | ------------------- | -------: | -------: | ------------------: | ------------------: |
| Selection | Decoded age p95, ms |       34 |       35 |               +1 ms |              +2.94% |
| Selection | Active CPU, %       |    71.04 |    71.09 |            +0.05 pp |              +0.07% |
| Selection | Idle CPU, %         |    23.64 |    24.54 |            +0.90 pp |              +3.81% |
| Selection | Peak RSS, MB        |  1143.70 |  1146.13 |            +2.42 MB |              +0.21% |
| Holdout   | Decoded age p95, ms |       37 |       37 |                0 ms |                  0% |
| Holdout   | Active CPU, %       |    67.89 |    68.24 |            +0.35 pp |              +0.52% |
| Holdout   | Idle CPU, %         |    24.12 |    25.97 |            +1.85 pp |              +7.67% |
| Holdout   | Peak RSS, MB        |  1136.69 |  1135.89 |            −0.80 MB |              −0.07% |

Target status: no eligible performance improvement demonstrated or retained. All final integrity checks passed. Per-case regression reporting was not configured; it is unrecorded, not an asserted empty regression list. No accepted candidate was tested on holdout; final holdout confirms the unchanged baseline only.

## Native comparison, upstream evidence, and format choice

The earlier investigation exercised Xcode 27.2's native **Device Hub**, outside Orca's embedded view, on the same simulator. The native profile showed Core Animation/IOSurface rendering; the streaming helper showed AppleJPEG work. Native presentation FPS and input-to-photon latency were not quantified, so an exact native-versus-Orca latency ratio is unknown.

Earlier live-source probes, not controlled end-to-end candidate comparisons:

| Existing source endpoint | Received frames/s | Payload Mbps |
| ------------------------ | ----------------: | -----------: |
| MJPEG                    |             51.56 |        85.48 |
| H.264 AVCC               |             54.81 |         5.33 |

Those separate probes support testing a video path for bandwidth reduction. They do not establish its rendered freshness, CPU cost, motion quality, or lifecycle correctness in Orca. JPEG encode/transport/decode adds work absent from a direct surface presentation path; it is a streaming architecture tradeoff, not proof of a generic macOS or Electron bug.

No ADR or explicit lighter-footprint rationale was found in the inspected current documentation or original [Orca PR #4754](https://github.com/stablyai/orca/pull/4754). Do not infer that MJPEG was selected because it was lighter. Upstream [serve-sim PR #78](https://github.com/EvanBacon/serve-sim/pull/78) explicitly introduces H.264 against bandwidth-heavy MJPEG while retaining JPEG compatibility.

Upstream [serve-sim PR #171](https://github.com/EvanBacon/serve-sim/pull/171) addresses per-frame blocking service work, surface caching, lazy JPEG work, and resolution-scaled H.264 bitrate. At investigation time, pinned 0.1.47 and stable 0.1.48 lacked it; published 0.1.49-beta.140.1 contained its source, but the beta was not executed. Upstream [PR #180](https://github.com/EvanBacon/serve-sim/pull/180) concerns Home-button subprocess latency and had requested changes; it is not a ready general rendering fix. Orca's merged [PR #32967](https://github.com/stablyai/orca/pull/32967) improves parser accumulation but leaves the frame gate in place.

The next evidence-backed direction is an independently scoped AVCC/video integration or a stable upstream helper update, not additional 30-fps timers. Reuse existing decoding infrastructure where possible, but iOS AVCC configuration/framing is not the Android Annex-B path. Verify keyframe/reconnect handling, mixed-version remote compatibility, rotation, hidden/inactive parking, CPU, bandwidth, and rendered freshness. A fixed tiny bitrate can hurt full-resolution heavy motion; do not assume minimum bitrate means minimum latency. Expected end-to-end gain is currently unknown.

## Review, verification, and accounting

Independent approach reviews completed on `openai-codex/gpt-6-astra:high` and `cursor/grok-4.7:high`. Full-run model-change/thinking metadata confirmed both identities without fallback. Astra favored latest30; Grok favored the cap60 control and warned that waiting could worsen freshness. Measurements, not reviewer agreement, determined rejection.

**The requested Opus review is missing.** The initial `kiro/claude-opus-5.5:high` attempt exhausted authentication/rate-limit retries. Two further attempts, including the user's explicit retry, failed with HTTP 400 invalid-model/subscription errors. No substitute was counted as Opus, and the three-model review is not complete. No retained production diff exists for a final code review.

Executed verification:

- Original stream/parser tests: two files, 13 tests passed.
- Experimental scheduler plus parser tests: two files, 21 tests passed, including quiet final delivery and stop/error/reconnect/replacement behavior.
- Both candidates: three valid alternating selection pairs each; final state: three selection and three held-out pairs, all visual/integrity gates passed.
- Candidate tests initially could not start through a symlinked `node_modules`; installing the same frozen-lockfile dependencies into a real directory resolved pnpm's directory-safety refusal. This setup failure is not a behavior or performance result.

The required handoff command is `ORCA_BACKGROUND_LAUNCH=1 pnpm check:changed --maxWorkers=2`.

Stop: approved plateau of two non-winners. Outcomes: two reverted; zero kept, not-selected, inconclusive, censored, deferred, terminal-error, or timeout experiments. One candidate launch attempt timed out before sampling and was corrected before valid measurements.

Local audit state is `.context/compound-engineering/ce-optimize/simulator-stream-hillclimb/`: `spec.yaml`, `experiment-log.yaml`, raw measurement JSON, and the benchmark. These ignored files remain in the preserved worktree, not in this report-only commit. Use the saved measurement commands and existing Electron executable recorded in the spec to reproduce locally. Benchmark SHA-256: `4bb01934064c24c3c26ef273d2b3a8a1c5cce9867dc3ac2449555fbb23786417`; corpus SHA-256: `a9049ec48e1dcb8052b285811380552e4ba67b9076c654da9eefcf7d90834913`.
