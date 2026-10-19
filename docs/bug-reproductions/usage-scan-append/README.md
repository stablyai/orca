# Usage scans after a transcript append

Latest follow-up: [lossless source compression](./source-compression.md) removes the disk increase in three measured histories, with CPU costs reported. Earlier tables below describe the uncompressed implementation.

Claude usage refresh previously cached a transcript only while its modification time and size were unchanged. Appending one usage row invalidated that cache and parsed every earlier user, tool and assistant row again. The production route is `ClaudeUsageStore` → `UsageProviderStoreLifecycle.runScan` → the usage worker → `scanClaudeUsageFiles`. Long tool output therefore made a small usage refresh expensive even when the number of usage records stayed fixed.

The regression is deterministic: the append test measures bytes returned by the real filesystem reader. Before the fix, a 424-byte append to a 1,083,929-byte transcript read 1,084,353 bytes. The new scan reads a verified suffix and a fixed amount of prefix evidence. It retains all usage history and places no new cap on transcripts, rows or tokens.

## Reproduce

From the repository root:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm test src/main/claude-usage src/main/usage/jsonl-line-offsets.test.ts
ORCA_BACKGROUND_LAUNCH=1 pnpm test src/main/codex-usage
ORCA_BACKGROUND_LAUNCH=1 ORCA_CLAUDE_USAGE_APPEND_BENCH_ROUNDS=8 ORCA_CLAUDE_USAGE_APPEND_BENCH_BASELINE=51e7181850b022bae2d41091fe1229accef4bd50 node config/scripts/claude-usage-append-benchmark.mjs --compare --verify
```

Run the timing benchmark while builds, test suites and other benchmarks are idle. It uses temporary transcript directories and loads the actual scanner through an esbuild bundle. Account/profile discovery is isolated; transcript reads remain real. The I/O wrapper records stream bytes and descriptor window reads without counting descriptor stream internals twice. Its accounting smoke check verifies one complete file read plus an eleven-byte descriptor read. Unaccounted `readFile` and `readv` APIs fail the benchmark.

The current comparison loader pins every project dependency to its named baseline commit and freezes the current source graph. The historical comparison below overlaid named Claude modules; the original scanner's five-module graph came entirely from the original commit. Fixtures are identical across arms. Arm order alternates across rounds; each round records scanner-cache-cold, unchanged, append and fresh-after-append phases. “Cold” describes the scanner cache: newly written fixtures can already be in the operating system page cache. Raw samples include read counts, bytes, scanner duration, cache serialization duration, serialized state bytes, source hashes and environment. Separate scanner and serialization values prevent a cursor from merely moving work into persistence.

The fixture set includes one thousand small transcripts; two and thirty-two MiB of UTF-8 user/tool output with the same 256 usage keys; and thirty-two MiB with 4,096 and 16,384 usage keys. Every appended result must match a fresh scan of the same bytes. Across baseline/current arms, additive checkpoint and generation metadata are excluded from behavioral comparisons; sessions, daily aggregates, per-file aggregates, line counts and owned keys are compared.

## Initial controlled results

This comparison records the original append fix before the later protected source-sidecar and column-storage refinement. Its source hashes and raw samples remain unchanged; the later persistence measurements below use their own complete source graphs.

The final [comparison.jsonl](./comparison.jsonl) contains eight counterbalanced rounds per scenario on Node v24.20.0, macOS arm64, Apple M4 Max. Baseline is commit `51e7181850b022bae2d41091fe1229accef4bd50`. Each arm ran first four times. No builds, tests, app or competing benchmark ran during the measurement. All eleven recorded current runtime-source hashes and four tool hashes were checked against the frozen worktree after the run. Exact within-arm cold parity, cross-arm behavioral parity and byte budgets passed.

The table shows medians. Time is the scanner plus compact cache serialization; the raw artifact records these separately and retains every unrounded sample.

| Tool payload / owned usage keys | Appended bytes | Before bytes read | After bytes read | Before time | After time | Before serialized cache | After serialized cache |
| ------------------------------- | -------------: | ----------------: | ---------------: | ----------: | ---------: | ----------------------: | ---------------------: |
| 2 MiB / 256                     |          4,730 |         2,288,956 |           29,306 |    5.943 ms |   0.616 ms |                 8,196 B |               13,689 B |
| 32 MiB / 256                    |          4,730 |        34,534,456 |           29,306 |   81.513 ms |   0.741 ms |                 8,197 B |               13,691 B |
| 32 MiB / 4,096                  |          4,748 |        36,560,492 |           29,324 |   92.323 ms |   3.093 ms |               114,262 B |              188,877 B |
| 32 MiB / 16,384                 |          4,766 |        43,062,968 |           29,342 |  124.310 ms |  10.651 ms |               471,124 B |              766,924 B |

For the 256-key large transcript, scanner time alone fell from 81.494 ms to 0.724 ms, and append bytes read fell by 99.915%. Increasing transcript payload by 15.117× left appended reads unchanged. Increasing owned keys still increased scanner and serialization work, as expected. The cache is larger than the original aggregate-only cache because five old maxima must remain available to update a repeated historical key correctly.

The cold full-scan path also improved on these large fixtures: the 32-MiB/256-key scan took 82.270 ms before and 35.014 ms after, with sixteen KiB of extra evidence reads. The new raw-buffer line reader builds each complete line once, while retaining exact byte offsets. This timing includes the projection and checkpoint cost; it is not a separate parser microbenchmark.

The small-file tradeoff is visible. A thousand initial transcripts contain 459,780 bytes in total; appending a repeated maximum to each raises their total to 920,560 bytes. Full snapshot verification requires one additional read of each small file.

| Thousand-file phase | Before scan | After scan | Before bytes read | After bytes read |
| ------------------- | ----------: | ---------: | ----------------: | ---------------: |
| Cold                |   73.233 ms |  94.872 ms |           459,780 |          919,560 |
| Unchanged           |    9.176 ms |   9.400 ms |                 0 |                0 |
| Changed             |   71.938 ms |  94.933 ms |           920,560 |        1,841,120 |

Small-file cold scans cost about 21.6 ms more across this thousand-file fixture, a 29.5% increase. Unchanged refreshes retain zero transcript reads. This verification cost prevents a short, rotated or rewritten snapshot from being published under complete-file metadata; it is not hidden by excluding tiny files or adding a history cap. Scanner execution remains on the existing usage worker.

At 16,384 keys, the normalized cache is 766,924 bytes, compared with 6,203,025 bytes in the retained pre-normalization artifact: 87.6% fewer serialized bytes. The older run is evidence for the removed duplication, not a controlled timing comparison. Final scanner-plus-serialization time remains 10.651 ms at that key count, so the result does not claim constant total cost.

## Shared reader before provider-specific projection

The durable byte reader and checkpoint evidence were extracted from Codex into `src/main/usage/jsonl-file-checkpoint.ts` and reused by both providers. The persisted Codex checkpoint fields remain compatible. The extraction also repairs a demonstrated race: path verification followed by a new path open could merge an old prefix with a replacement file, then publish the replacement's metadata over those old totals and reuse the result indefinitely.

Verification, initial stat, parsing and checkpoint creation now use one pinned descriptor. Parsing ends at the initial file size, so an append after the scan starts is picked up by the next refresh. Before publishing, the reader proves the complete requested byte range was consumed, checks the current path still names the opened generation, validates its original byte evidence and rejects truncation or changed snapshot evidence. Failed generations discard speculative projection and ownership before a cold retry. A short stream, digest window or legacy-prefix read on an unchanged snapshot propagates an error instead of publishing partial totals or retrying forever. Reopening requires positive generation or metadata change and closes each failed attempt once. Normal completion closes the owning handle; borrowed descriptor streams are not destroyed independently because that closes the descriptor on Node as well.

The inherited 12-KiB resumable-prefix crossover avoids paying more evidence work than a full read on tiny files. Tiny files hash the bytes actually parsed and verify them with one post-read descriptor read, including deliberately skipped legacy prefixes. They therefore read twice on a cold or changed scan, while unchanged files read zero bytes. Large cold scans add four 4-KiB evidence pages; a normal large append adds six pages. These costs are measured explicitly.

## Claude projection and cache compatibility

Claude assistant rows are deduplicated by their existing request/message key. A repeated key keeps its first session, timestamp, model and location attribution, while each of the five token counters takes its independent maximum. The incremental projection applies only the token difference to the original session, day, model and location. It does not create another turn. A zero-cache-read turn is decremented once when that key's cache-read maximum changes from zero to positive. An invalid first timestamp remains invalid even when a later repeated row has a valid timestamp.

The persisted encounter order preserves cold-scan sorting when a token update creates a tie between locations, or a new row creates a timestamp tie between sessions. Keyless rows remain ordinary counted turns. Completed-line count is stored separately from the exposed line count: an unterminated fragment is counted once and read again after completion. A parseable unterminated usage row, including a duplicate that only raises maxima, suppresses resume until its provisional contribution can be parsed safely.

Cached cross-file ownership is retained while a changed owner is being read. Once that read validates, actual deleted or dropped keys are released and deferred forks reclaim them. A small owner's ordinary append therefore does not force every unchanged deferred fork to reread its history. Deletion, truncation and replacement that actually lose an owned key still recover that history from a surviving fork.

Generation metadata is stored independently of a resumable checkpoint, including for small files and parseable partial tails. Same-size replacement with a restored modification time is invalidated by physical identity; same-size in-place change with a restored modification time is invalidated by change time where available. Old cache entries lacking this metadata are cold-scanned once, then use unchanged zero-read reuse. Missing or unrecognized incremental state falls back to a full parse without discarding tracking preferences.

Resume state is validated at the boundary. It checks key coverage, compact tuple shape, finite token values, projection indexes and routing, and full session/location encounter-order coverage. Malformed state falls back to a cold scan instead of losing rows, double counting repeated keys or throwing during a correction.

## Retained state and remaining scaling

The first implementation repeated each key and its full routing metadata in an owned-turn map. The isolated pre-normalization run measured 6,203,025 serialized bytes at 16,384 usage keys, with 4.306 ms spent serializing one appended scan. That exposed a second cost before finalizing the fix.

The normalized state reuses the existing ordered `ownedDedupeKeys` array. Parallel tuples store five maxima and a routing index; session/day/model/location routes are interned once. Existing-key updates retain their positions; new keys append. Tests include reversed suffix key order and JSON persistence between updates. Appends now use the tuples directly, replacing only corrected rows and sharing unchanged rows without mutating prior state. This removes the historical owned-turn object hydration and full tuple re-encoding pass.

Transcript-payload growth no longer determines append reads. Hydration, key validation, aggregate cloning and serialization still scale with the number of owned usage keys and rollups. The benchmark reports these costs rather than claiming constant total time or constant retained state. It also reports the small-file verification overhead rather than hiding it in a large-file average.

`pre-normalization.jsonl` retains the earlier same-source measurement that motivated the compact codec. It is not the final baseline/current timing comparison; source and method changes prevent treating those separate runs as controlled timing evidence.

## Protected worker cache and visible report

The final implementation reuses upstream's worker-owned source sidecar and `whenLoaded` barrier. Per-file ownership, token maxima and checkpoint routes stay on the usage worker; main retains the session/day report. The disk codec packs each of six token columns as one scalar when all values match, or an exact dense column otherwise. It changes no worker or public usage-report shape, keeps every key and maximum, and serializes one file's columns at a time.

Unchanged refreshes retain the sidecar only after verified schema 7, clean normalization and identical file count, order and references. Any change, repair or legacy upgrade writes a new source generation. Report completion and report persistence still run.

Schema 7 source files and reports have separate SHA-256 guards over their exact JSON bytes. The source guard includes small files that have no resumable checkpoint. The worker verifies its source bytes before granting a request-local reuse proof; direct scanner callers and genuine older signed files still pass the coupled key/maxima/route/rollup validation. A malformed owner also invalidates deferred forks so the next scan can reclaim copied history. The checksum detects accidental drift; it does not authenticate a cache deliberately changed and re-sealed by another writer.

The report is authoritative for startup independently of the sidecar. A failed source write may leave an older sidecar, and a crash before report commit may leave a newer sidecar. Neither case replaces displayed report totals with another generation's totals. Legacy inline migration verifies protected files and reconstructs its report before splitting; invalid projections clear all visible totals and completion rather than presenting a partial history. An existing compatible newer sidecar survives a repeated migration after a failed report write.

Genuine unsigned schema 6 reports remain readable with their existing cache-trust policy until a successful source scan creates schema 7. Older signed tuple checkpoints migrate through their original coupled guard. Schema 7 requires valid integrity framing, including when a digest is removed. Downgrading to a schema 6 app causes a one-time cold rebuild while preserving tracking preferences.

Small reports keep upstream's synchronous load. Reports above its eight-MiB threshold use the existing worker operation; the verification fact is attached to the exact returned report text, so main does not hash those bytes again. Main still parses and serializes its visible rollups. If the worker is unavailable, `whenLoaded` covers the exceptional inline validation on main, including disabled cached history. Preference writes preserve that original inline source generation until a successful scan, and shutdown still drains writes after a failed preference write. This fallback can be slower, but does not retain the historical source graph in main.

Source-cache parsing, column decoding, key indexing, rollup cloning and durable sidecar writes still scale with cached history. The refinement moves this work off main and removes redundant representations; it does not claim constant total refresh time, bounded history, or universal detection of transcript rewrites.

## Final Claude persistence measurements

The [final evidence receipt](./claude-resource-evidence-receipt.json) verifies every captured production dependency, tool and artifact. [Detailed costs and limits](./hardening-summary.md) distinguish the original commit, published PR, merged upstream main and final worktree. The final timing drivers use six counterbalanced rounds with complete pinned source graphs and actual source-cache read/verification/decoding, scanning and durable source/report writes. Worker startup, IPC transport/queueing, telemetry, worktree discovery and rendering are excluded.

| Owned keys / phase          | Published PR | Upstream main |      Final |
| --------------------------- | -----------: | ------------: | ---------: |
| 16,384 repeated / cold      |    72.455 ms |     61.117 ms |  83.160 ms |
| 16,384 repeated / unchanged |    13.106 ms |     21.844 ms |  12.290 ms |
| 16,384 repeated / append    |    28.000 ms |     61.131 ms |  28.876 ms |
| 100,000 unique / cold       |   385.203 ms |    265.264 ms | 390.682 ms |
| 100,000 unique / unchanged  |    34.915 ms |     36.950 ms |  30.662 ms |
| 100,000 unique / append     |   128.631 ms |    267.204 ms |  84.152 ms |

The [16k](./claude-persistence-cost-final-16k.json) and [100k](./claude-persistence-cost-final-100k.json) measurements retain every sample. Each unchanged final scan writes zero source-cache bytes, while still reading 471,838 or 6,126,038 source bytes and persisting a small report. At 100k, appended transcript reads fall from 47,323,259 to 25,030 bytes; including the source sidecar, total logical payload reads fall from approximately 50,303,147 to 6,151,068 bytes. These are measured operation costs, rather than whole-app latency or physical device I/O.

The [four-arm byte check](./claude-persisted-bytes-final.json) uses actual production layouts and indentation. At 16k repeated maxima, final report plus sources take 538,876 bytes: 29.8% below the published PR, 14.1% above main and 13.2% below original source. At 100k unique maxima, final state takes 6,128,046 bytes: 3.2% below the published PR, 105.5% above main and 57.8% above original source. One ownership-key list and the six dense token/routing columns dominate that adverse case; no duplicate key list remains. Dense cold rebuilding also remains slower than main, and the 16k complete append is slightly slower than the published PR despite a faster scanner.

The [readiness diagnostic](./claude-readiness-cost-final.json) retains disabled history with zero per-source records on main. Upstream's report-only startup already removes the large source graph from main, so that improvement is inherited. First legacy migration becomes ready in 94.434 ms versus main's 63.060 ms. Exceptional validation yields 293 times, but its initial legacy parse still occupies main. A separate 13.87 MB report still requires a 16.512 ms observed main parse segment, and final serialization/checksum costs 20.628 ms versus main's 16.183 ms. These observations do not establish universal latency bounds.

Reproduce final evidence while other builds, tests, apps and benchmarks are idle:

```sh
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-persistence-cost-benchmark.mjs --usage-keys 16384 --maxima-pattern repeated --rounds 6
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-persistence-cost-benchmark.mjs --usage-keys 100000 --maxima-pattern unique --rounds 6
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-readiness-cost-benchmark.mjs --usage-keys 100000 --large-report-mib 13 --rounds 6
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-persisted-bytes-check.mjs
```

Each tool accepts `--output`; the timing tools also accept `--published-ref` and `--main-ref`. Default immutable refs and complete provenance appear in the artifacts. Equivalent environment-variable launchers work on Windows. These macOS measurements make no Windows or SSH latency claim.

## Codex parser retained memory

Codex folds each owned event into the existing session/day accumulator while reading. It keeps ownership keys and rollups, instead of an attributed-event array for the whole transcript. Claims are published only after descriptor validation; rejected reads discard their speculative rollups. Deferred records still advance cumulative token context.

Run the separate memory comparison while other benchmarks and builds are idle:

```sh
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/codex-usage-parser-memory-benchmark.mjs --baseline-ref 51e7181850b022bae2d41091fe1229accef4bd50 --events 100000 --pairs 2 --sample-ms 35 --output docs/bug-reproductions/usage-scan-append/codex-parser-memory.json
```

The baseline bundles every project source dependency of the actual parser from the named commit; the current arm bundles and hashes the worktree dependency graph before starting workers. Each arm, scenario and round runs in a fresh Node process. Two rounds alternate baseline/current and current/baseline. The 100,000-record fixture has distinct timestamps and fixed token values. One scenario owns every record; the other defers 90% to a simulated prior owner. Both arms must preserve identical sessions, daily aggregates, owned keys and deferred state, with exact event and token totals.

Workers force two full garbage collections before parsing, every 35 ms during parsing, and after parsing with the returned result retained. Raw snapshots include heap, RSS, external buffers and elapsed time. The reported peak is the largest **sampled retained heap** increase; it does not measure absolute peak allocation or total process memory. Forced GC affects elapsed times, so this is a memory comparison rather than a speed benchmark. The artifact records runtime/platform details, fixture hash, all bundled source hashes, bundle hashes, instrumentation hashes, arm order and correctness counts.

The final [`codex-parser-memory.json`](./codex-parser-memory.json) comparison used Node 24.20.0 on darwin/arm64, an Apple M4 Max, and the 20,200,079-byte fixture. All eight fresh workers collected samples during parsing (3–12 per worker). The two counterbalanced runs measured these retained-heap increases:

| Owned records             | Baseline sampled peak (MiB) | Current sampled peak (MiB) |
| ------------------------- | --------------------------: | -------------------------: |
| All 100,000               |              44.681, 44.953 |               9.071, 7.964 |
| 10,000, with 90% deferred |                3.692, 3.746 |               1.233, 1.251 |

Every arm retained exactly 100,000 or 10,000 keys and counted events, with identical full usage-projection hashes and exact token totals. Final returned-result retention stayed approximately 6.49 → 6.51 MiB with all keys owned and 0.97 → 1.00 MiB with 90% deferred: the improvement removes intermediate event retention while preserving the result. Raw artifacts include all 16 baseline and 18 current source-module hashes; each current source and instrumentation hash matched the frozen worktree after the run. Snapshot records themselves add small duration-dependent observer overhead. A separate 1,000-record smoke passed parity but correctly flagged every measurement as final-only, so it is not used as peak-memory evidence.

`codex-memory-exploration.json` preserves the earlier actual-parser exploratory measurements: approximately 45.5 → 7.6 MiB sampled retained heap with all 100,000 keys owned, and 3.7 → 0.9 MiB with 10,000 keys owned. That earlier run overlaid only the baseline parser onto current dependencies and did not save source hashes or individual snapshots. Its limitations are explicit; the pinned full-graph comparison provides reproducible final evidence.

## Correctness coverage and limits

The final [validation record](./validation.json) captures the frozen source hashes,
8,278 passing integrated tests across 839 files, 118 performance contracts,
full typechecking, changed-code quality, formatting and artifact hash checks.
The contract workflow is configured for Linux, macOS and Windows; this local run
used macOS. [Rendered Electron evidence](https://github.com/stablyai/orca/blob/nwparker/perf-native-chat-tool-pairing/docs/bug-reproductions/native-chat-tool-pairing/rendered-validation.json)
records the rebuilt hidden app, output/task ownership and process cleanup.

Focused suites cover UTF-8 byte offsets, CRLF and tiny chunks; duplicate maxima and first metadata; keyless rows; malformed and parseable partial tails; restart after JSON persistence; location and session ties; worktree/folder attribution; owner deletion and key loss; truncation while opening; replacement and rewrite races; appends after the pinned stat; old-cache upgrade; malformed resume state; and stable short reads with single-handle cleanup and no partial ownership publication. An independent actual-source differential check ran 24 seeded append phases with 512 assistant rows, five sessions, three locations, three models, duplicate maxima, shifting metadata, invalid first dates and a JSON round trip before each resume. Sessions, daily aggregates and line counts matched cold scans after every phase.

Head and committed-boundary digests are evidence for the append-only contract, not a universal proof of every byte. Arbitrary middle-only rewrites that also grow a file while preserving the sampled windows can evade bounded evidence. Same-length dirty files take the full-parse path; changed same-length metadata during a read rejects the snapshot, and small-file validation hashes the full bytes. No new arbitrary history bound is used to conceal this limitation.
