# Usage scan hardening and remaining costs

Claude keeps every historical ownership key and its five independent token maxima so an appended correction can update the original attribution. The final refinement shares unchanged tuple rows during an append, stores scalar or dense columns on disk, and validates source checkpoints on the usage worker. Main retains a separately protected aggregate report. The source/report split and `whenLoaded()` lifecycle came from upstream main; this PR adds the protected codec, source/report authority checks and guarded unchanged-source write reuse to that architecture.

An unchanged source sidecar is retained only after schema 7 and its raw JSON checksum validate, normalization preserves every source, and the scanner returns identical file references in the same order and count. Changes, repairs and legacy upgrades write a new source generation. Report completion and report persistence still run. Raw checksums cover tiny unsigned source records as well as resumable checkpoints; source and report use different checksum domains. Corrupt sources force a cold scan while an independently valid report remains readable. A corrupt report clears its totals and explains the required rebuild. Tracking preferences survive both cases.

Directory discovery distinguishes absent history from unreadable history. Permission and I/O failures reject the provider scan, preserving the previous completed totals and exposing an error. A deleted or genuinely absent directory remains valid absence. The [permission reproduction](./claude-discovery-coverage.json) demonstrates the earlier silent loss of a readable sibling session; deterministic error contracts cover environments where that POSIX permission experiment cannot run.

## Final source and measurement scope

The final artifacts compare published Claude PR commit `8467877ed92aba2ef59737aebf461e9cab52c273`, merged upstream main `b44a5796c1154de84efa25cc09f3dae2b61eb4b5`, and the frozen worktree. The [four-arm byte check](./claude-persisted-bytes-final.json) also includes original commit `51e7181850b022bae2d41091fe1229accef4bd50`. Every bundled project dependency comes from its named commit or the captured worktree snapshot. The [evidence receipt](./claude-resource-evidence-receipt.json) records tool/artifact hashes and verifies the complete source graphs after measurement.

Six permutations balance the three timing arms across six rounds. The fixtures are scanner-cache cold and operating-system-page-cache warm. Production source-cache read/verification/decoding, scanning, source packing/checksumming/durable writes and report serialization/durable writes are measured in their production order. Durable writers include file sync and replacement. Timings exclude worker startup, IPC transport/queueing, telemetry, worktree discovery and rendering. They measure these operations, not whole-app speed. Every appended projection matches a fresh scan and the other arms' session/daily projections.

## Actual persistence and refresh costs

The [byte check](./claude-persisted-bytes-final.json) uses each arm's actual production layout and indentation. Totals include the report plus source sidecar where present.

| Owned keys / maxima | Original full state | Published PR full state | Upstream main report + sources | Final report + sources |
| ------------------- | ------------------: | ----------------------: | -----------------------------: | ---------------------: |
| 16,384 / repeated   |           620,849 B |               768,008 B |                      472,318 B |              538,876 B |
| 100,000 / unique    |         3,883,175 B |             6,327,802 B |                    2,981,812 B |            6,128,046 B |

The final representation is 29.8% smaller than the published PR at 16,384 repeated maxima and 3.2% smaller at 100,000 unique maxima. It is 14.1% and 105.5% larger than aggregate-only upstream main. The unique fixture has two attribution days, so all six columns are dense: one ownership-key list takes 2,977,781 bytes and the five maxima plus routing column take 3,145,041 bytes. There is no second key list to remove. At 16,384 repeated maxima, one correction expands one scalar column to a dense column; its exact values remain retained. No cap, dropped history or assumed correlation between counters hides this cost.

The [16k](./claude-persistence-cost-final-16k.json) and [100k](./claude-persistence-cost-final-100k.json) artifacts include actual source and report persistence. Times below are complete measured-operation medians; individual phase medians need not add to their total median.

| Owned keys / phase          | Published PR | Upstream main |      Final |
| --------------------------- | -----------: | ------------: | ---------: |
| 16,384 repeated / cold      |    72.455 ms |     61.117 ms |  83.160 ms |
| 16,384 repeated / unchanged |    13.106 ms |     21.844 ms |  12.290 ms |
| 16,384 repeated / append    |    28.000 ms |     61.131 ms |  28.876 ms |
| 100,000 unique / cold       |   385.203 ms |    265.264 ms | 390.682 ms |
| 100,000 unique / unchanged  |    34.915 ms |     36.950 ms |  30.662 ms |
| 100,000 unique / append     |   128.631 ms |    267.204 ms |  84.152 ms |

The guarded unchanged path writes zero source bytes in every recorded round. It still reads and validates 471,838 bytes or 6,126,038 bytes of source cache, and writes a 1,515-byte or 2,023-byte report. Dense cold scans remain slower than aggregate-only main. At 16k, the additional durable source/report commit offsets the faster append scanner relative to the published PR: 28.000 to 28.876 ms. At 100k, the final appended scanner takes 36.869 ms versus 105.960 ms in the published PR, and the complete measured append falls to 84.152 ms. These are visible tradeoffs, not universal speed claims.

Transcript I/O and all cache I/O are different quantities. The 100k append reads 25,030 transcript bytes versus main's 47,323,259 bytes, but it also reads the 6,126,038-byte source sidecar. Total logical payload reads are therefore 6,151,068 bytes versus approximately 50,303,147 bytes, not a 99.9% reduction in all refresh traffic. Logical payload counts are not physical device I/O.

## Readiness and remaining main-thread work

The [readiness measurement](./claude-readiness-cost-final.json) uses the actual store lifecycle and prestarted Node workers calling the production splitter. Inactive telemetry/analytics/worktree paths throw if reached. Disabled history remains accessible after `whenLoaded()`, and main retains zero per-source records.

For the one-session, 100k-key fixture, published synchronous loading takes 36.034 ms; upstream main's report-only load takes 0.092 ms and the final protected report takes 0.116 ms. Moving the source graph away from main is inherited upstream behavior, rather than a gain attributable solely to this PR. The final first inline migration takes 94.434 ms to become ready, versus 63.060 ms on upstream main; validation and source publication add worker work. Its initial legacy JSON read/parse still occupies main for an observed 8.752 ms.

Worker unavailability preserves disabled history through a cooperative main fallback. The 100k legacy fixture yields 293 times, with a median maximum observed validation segment of 0.493 ms, but its initial legacy parse still occupies main for 8.574 ms. Those observations are not universal bounds: large metadata records, aggregate merging and sorting can remain synchronous.

A separate 13,869,588-byte report with 13,222 distinct rollups exposes the remaining aggregate-report limit. Trusting validation of the exact worker-returned report text removes a repeated main checksum pass: the observed main segment falls from 21.393 to 16.512 ms. Main still parses the entire report; upstream main shows 16.690 ms for that parse path. Final readiness is 44.394 ms versus upstream's 39.592 ms, and main serialization plus checksum takes a median 20.628 ms versus upstream serialization's 16.183 ms. If the worker fails, report parse plus verification occupies main for an observed 22.326 ms. This diagnostic preserves an independently valid report with absent source cache and does not claim a generated transcript-corpus parity result.

## Earlier measurements and persistent limits

[comparison.jsonl](./comparison.jsonl), [hardening-comparison.jsonl](./hardening-comparison.jsonl), [claude-hardening-cost-16k.json](./claude-hardening-cost-16k.json), [claude-hardening-cost-100k.json](./claude-hardening-cost-100k.json) and [claude-cache-representation-final.json](./claude-cache-representation-final.json) retain earlier source/layout measurements. Their inline-cache loading costs predate the worker-owned protected sidecar. Captured hashes remain unchanged even where later scripts differ. Final costs come from the separate final artifacts above.

The earlier canonical reader comparison documents the verification tradeoff: one thousand tiny changed files are read twice, while unchanged transcripts read zero bytes. Cold scanner time rose from 68.095 to 84.020 ms in that earlier run. Bounded head/boundary evidence remains an append-only check, not proof of an arbitrary unsampled middle rewrite that also grows the file. Same-length changes, replacement, truncation and invalid checkpoints fall back to full parsing. No automatic whole-corpus audit or new history-rebuild UI was added.

Schema 7 fences older builds from interpreting protected columns as legacy inline state. Schema 6 remains an explicit migration path. Downgrading to an older build requires a cold rebuild before cached totals reappear; tracking preference remains preserved. Source/report write failures can cause a later colder scan, and one unreadable transcript still prevents a complete provider refresh. Checksum validation detects accidental inconsistency; it is not a signature against deliberate resealing.

All per-source work belongs to the execution host. Public snapshots carry aggregate reports, rather than checkpoint arrays. The measurements do not establish Windows, SSH or whole-app latency improvements, and there are no machine-dependent timing gates.

## Reproduce

Run timing tools while builds, tests, apps and other benchmarks are idle:

```sh
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-persistence-cost-benchmark.mjs --usage-keys 16384 --maxima-pattern repeated --rounds 6
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-persistence-cost-benchmark.mjs --usage-keys 100000 --maxima-pattern unique --rounds 6
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-readiness-cost-benchmark.mjs --usage-keys 100000 --large-report-mib 13 --rounds 6
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-persisted-bytes-check.mjs
```

Each accepts `--output`. Timing drivers accept `--published-ref` and `--main-ref`; defaults are the named immutable commits above. Equivalent environment-variable launchers work on Windows. The byte check uses fixed immutable refs and makes no timing claim.
