# Simulator helper quality-preserving comparison

Historical helper-only JPEG experiment, not the final PR's package or publication state. See the [final integration report](simulator-avcc-autonomous-report.md) for the later H.264 adoption; the measurements below remain unchanged.

## Decision

**The helper-only change saves CPU, but is not a complete snappiness fix. No production change retained.** serve-sim0.1.49-beta.140.1 preserved the measured image quality and reduced capture/client CPU. Repeated scrolling update rates were lower, stream traffic and memory changed little, and held-out confirmation was incomplete. Do not present this as a ship-ready win or as a solved lightweight-streaming goal.

The smallest tested candidate changed only the upstream helper, retaining Orca's current production MJPEG parser, 30fps cap, IPC, preload and renderer hook. No H.264 integration, new framework or production package update was made.

## Measured results

Medians of three selection runs per version; each run exercises scrolling text and textured motion. Worst metrics are the per-run maximum across those workloads. CPU100% means one core; memory is summed sampled RSS, not unique physical memory.

| Metric                                             | Current0.1.47 | Isolated beta |
| -------------------------------------------------- | ------------: | ------------: |
| Worst source→decoded p95                           |          77ms |          68ms |
| Scrolling p95                                      |          68ms |          67ms |
| Motion p95                                         |          77ms |          68ms |
| Worst client+worker CPU                            |        150.9% |         95.2% |
| Worst IPC payload                                  |     100.5Mbps |      96.5Mbps |
| Worst combined sampled RSS                         |        1807MB |        1780MB |
| Scrolling unique decoded updates/s                 |         26.42 |         23.81 |
| Motion unique decoded updates/s                    |         25.05 |         24.67 |
| Helper CPU after viewer stops, source still moving |        76.50% |         1.67% |

CPU fell by55.7 percentage points (36.9% relative); worst p95 improved9ms (11.7%). Scrolling p95 changed only1ms and was inconclusive. Scrolling cadence fell about9.9%, which matters to the user's snappiness goal even though cadence was diagnostic rather than a hard gate in this run. Memory and IPC changes were inside the configured comparison threshold. No physical display FPS, input-to-photon, or whole-system energy claim.

## Correctness and fidelity

- All twelve selection workload cases passed real stream, barcode CRC/mode/counter, timestamp, sequence, native1206×2622, hidden compositor and teardown checks. No payloads arrived after stop.
- Each saved decoded moving frame was compared against an actual native simulator screenshot replaying its exact source counter. The native UIKit scene is deterministic; replay timestamps intentionally differ and are excluded. No static-only quality proof substituted for moving content.
- Before candidate selection, calibration accepted native self/JPEG controls and rejected a wrong-frame pair, a constant-body shortcut, and the earlier visibly coarse6Mbps AVCC sample.
- A baseline-only mismatch was located at native rows2583–2591 in the bottom system-overlay/safe-area region. The quality crop was fixed before baseline/selection to x48,y528,w1110,h1920. Both variants use this same crop; HUD and bottom system overlays are excluded.
- Quality gates: native raw RGB PSNR no more than3dB below the calibrated JPEG control and fixed402×874-area-reduced SSIM no more than0.005 lower. The beta passed these checks. Full-resolution candidate/source PNGs remain available. These metrics are not ICC-managed or a claim of perceptual identity; the display-size filter is a mathematical3×3 average, not Chromium's exact scaler.

## Confirmation and stop

The comparison tool returned promising/eligible on the three-repeat selection data, requesting holdout. The holdout used initialtick4000 rather than0. Both reference workloads completed, but only the candidate's scrolling workload completed: the predeclared04:24:34UTC experiment cutoff stopped its motion case. The completed held-out scrolling p95 was58ms reference /62ms candidate, so it does not establish a scrolling latency win. **Full held-out confirmation is absent; no keep.**

The absolute approved deadline is04:39:34UTC. The final quarter-hour was reserved for cleanup and delivery; no new candidate was started after the experiment cutoff. Default/higher-bitrate AVCC was prepared but **not executed** in this continuation. Its quality/performance remain unmeasured; prior low-bitrate numbers cannot substitute for them.

## What this establishes

The old helper keeps unnecessary JPEG/capture work after an external viewer disconnects. The new helper's lazy-JPEG/cached-surface path reduces that measured worker cost substantially. The remaining active MJPEG cost and approximately100Mbps payload support the next codec comparison, not more speculative scheduling changes. Source code and upstream [PR171](https://github.com/EvanBacon/serve-sim/pull/171) support the mechanism; only the table above is this run's measurement.

A future run should gate decoded cadence as well as age, complete the held-out set, then test upstream resolution-scaled AVCC at the same native-frame fidelity. Keep a main-owned transport and reuse the existing decoder lifecycle if it earns an integration; do not add WebRTC/FFmpeg or assume Android Annex-B equals iOS AVCC. Production adoption of the prerelease was not authorized by the isolated-test approval.

## Exact scope and evidence

- Workspace branch optimize/simulator-video-quality in simulator-stream-hillclimb. Production package remains serve-sim0.1.47. No production edits, push, PR, purchases, paid services or billing changes.
- Candidate exact npm0.1.49-beta.140.1, gitHead ede4c21ee3021a36fbee1fec106b388a50a5ce4e; SHA512 WmB2FtfbErO64EsvtVJmlkoxRF3gg0k3+I4TWudEf43MPBrcTeMWMdrIUSWFO/boVtdQBGEp1pYzilgfmgsE9g== independently verified. Packaged native addon, no native helper build.
- Both versions used identical minimal loopback HTTP mounts of their actual upstream simMiddleware/native engine, fresh directly owned workers and private TMPDIRs. Neither helper CLI ran, avoiding UI bootstrap and port-kill behavior. This proves capture-engine behavior, **not** Orca's detached CLI/materialized runtime, input/rotation, remote mixed-version or full-app integration.
- Fresh hidden/nonfocusable Electron clients used ORCA_BACKGROUND_LAUNCH=1; sparse PNGs were outside CPU samples. Reused the prior frozen benchmark; native replay only adds optional initial/frozen tick controls.
- Measurement program evaluate.mjs, saved spec.yaml, experiment-log.yaml, summary.json, baseline-1..3.json, candidate-mjpeg-1..3.json, holdout files, candidate receipt, and exact-frame PNGs remain under .context/compound-engineering/ce-optimize/simulator-video-quality/. Artifacts are ignored/local; this report is the durable branch artifact.
- Decision adapter encodes Boolean equality as numeric1 for the supplied numeric-only decide.mjs; expected gates and results are unchanged. The first exploratory decision payload mistakenly supplied one baseline sample and was rejected as insufficient; final scoring used all three actual baseline and candidate samples.
- The dedicated owned simulator was shut down and its helper listener was closed after this experiment. User devices were not modified.
