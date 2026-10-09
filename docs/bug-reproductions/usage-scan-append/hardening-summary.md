# Usage scan hardening and remaining costs

The final scanner retains suffix reads while rejecting corrupted checkpoints and incomplete filesystem discovery. A saved checksum binds owned keys, their five independent token maxima, attribution routes, encounter order, file evidence and cached rollups. A mismatched or missing checksum prevents suffix resume. Newly protected saved projections that fail validation no longer supply apparently complete totals on startup. Unsigned older entries retain unchanged aggregate reuse only when they contain matching physical file identity and change-time metadata. Entries missing that metadata need a full parse even when size and modification time are unchanged. Tracking preferences remain intact, and a rebuild explains why cached totals were withheld.

Directory discovery now distinguishes absent history from unreadable history through the existing filesystem absence predicate. Permission and I/O failures reject the scan, preserving the previous completed totals and exposing the scan error. A deleted or genuinely absent transcript directory remains valid absence. The [real permission reproduction](./claude-discovery-coverage.json) shows the original scanner silently replacing one readable session with zero sessions when a sibling directory is unreadable; the final scanner rejects `EACCES` and recovers the exact session after access returns. The script skips Windows ACL and privileged POSIX runs; deterministic error contracts cover those environments.

The shared reader uses exact bigint file identities without additional metadata calls. Safe numeric offsets and fractional timestamps preserve existing cache fields; bigint values stay inside the reader. Tiny snapshots use direct descriptor reads and complete byte comparison. Large snapshots retain pinned descriptors and bounded head/boundary evidence. Claude caches now use compact JSON through the existing writer instead of two-space indentation.

## Source provenance

All final timing comparisons below use original commit `51e7181850b022bae2d41091fe1229accef4bd50` as the before arm. This is the implementation before the performance improvements, not the already-published incremental-scanning PR. The published Claude PR before this hardening was `03a2ecaa00138ee44ad0dbb9dbd957cfe1a5e3f8`, based on reader commit `fced32bf21ba8e7a7c33b3bda712af582e5d47ca`. The final after arm bundles the frozen worktree modules and records their hashes in each artifact.

The scanner comparison overlays the five named Claude modules from the original commit onto frozen shared dependencies, as documented by the existing benchmark loader. Loader fingerprint labels marked `HEAD` mean that named original commit; the artifact's `baselineCommit` is authoritative. These measurements are not a three-arm comparison against the previously published PR.

[comparison.jsonl](./comparison.jsonl) and the earlier README results remain historical evidence for the previously published source. [hardening-comparison.jsonl](./hardening-comparison.jsonl) records the final canonical eight-round comparison. [claude-hardening-cost-16k.json](./claude-hardening-cost-16k.json) and [claude-hardening-cost-100k.json](./claude-hardening-cost-100k.json) separately measure actual production serialization and synchronous cache loading on deliberately dense usage histories. Current source, store and tool hashes matched the worktree when measured. The dense timing artifacts preserve that captured tool hash; their `reproductionTool` metadata records a subsequent rename from `shape` to `maximaPattern` for lint. Reversing all six occurrences reconstructs the captured SHA exactly, with fixtures and measured operations unchanged. The representation check was regenerated after its report property changed from `fullStateShape` to `stateFields`. Tests and builds did not run during the timing windows.

## Final append measurements

Canonical medians on Node 24.20.0, macOS arm64, Apple M4 Max include scanner time and compact source-cache serialization. They exclude cache hydration and durable disk writes. Each appended result matched a fresh scan, and aggregate projections matched the original implementation.

| Tool payload / owned keys | Before append reads | Final append reads | Before time | Final time |
| ------------------------- | ------------------: | -----------------: | ----------: | ---------: |
| 32 MiB / 256              |        34,534,456 B |           29,306 B |   83.266 ms |   0.829 ms |
| 32 MiB / 4,096            |        36,560,492 B |           29,324 B |   94.010 ms |   4.729 ms |
| 32 MiB / 16,384           |        43,062,968 B |           29,342 B |  125.406 ms |  14.459 ms |

Tiny files retain a verification cost. Across one thousand transcripts, cold scanner time rose from 68.095 to 84.020 ms: 15.925 ms, or 23.4%. Changed scanner time rose from 73.534 to 81.851 ms. Cold bytes read doubled from 459,780 to 919,560; changed bytes doubled from 920,560 to 1,841,120. The final implementation uses zero streams for these files, but still reads every changed small snapshot twice to verify its complete bytes. Unchanged scans read zero transcript bytes in both arms.

## Production cache and startup costs

The production writer previously indented the entire state. A [deterministic full-state representation check](./claude-cache-representation-final.json) at 16,384 owned keys measured 620,903 bytes before and 768,071 bytes after: 23.7% growth. Keeping indentation on the new state would consume 2,555,345 bytes. Compact serialization removes approximately 69.9% of that avoidable disk representation. Parsing compact and indented representations, and structured cloning the state, preserved identical data.

The dense-history benchmark excludes bulky tool output and includes cache loading that the canonical benchmark omits. It counterbalances eight rounds at 16,384 keys and four rounds at 100,000 keys. “Unique maxima” gives every key distinct token counters; no compression assumption hides that shape.

| Owned keys / shape        | Before append + production serialization | Final append + production serialization | Before JSON parse + load validation | Final JSON parse + load validation | Before production state | Final production state |
| ------------------------- | ---------------------------------------: | --------------------------------------: | ----------------------------------: | ---------------------------------: | ----------------------: | ---------------------: |
| 16,384 / repeated maxima  |                                38.941 ms |                               14.766 ms |                            0.417 ms |                           5.015 ms |               620,837 B |              767,993 B |
| 16,384 / unique maxima    |                                38.470 ms |                               14.434 ms |                            0.415 ms |                           4.967 ms |               620,949 B |              975,139 B |
| 100,000 / repeated maxima |                               248.679 ms |                               96.882 ms |                            2.447 ms |                          28.572 ms |             3,882,997 B |            4,782,596 B |
| 100,000 / unique maxima   |                               251.654 ms |                              109.479 ms |                            2.422 ms |                          33.420 ms |             3,883,159 B |            6,327,783 B |

Integrity verification is synchronous during cache loading and still scales with owned keys. At 100,000 unique keys, it adds roughly 31 ms of main-process work in this run. Cold dense scans also cost more: 252.208 to 351.264 ms at 100,000 repeated maxima, and 250.051 to 376.321 ms at 100,000 unique maxima. These fixtures demonstrate the costs when usage keys dominate the history. Large tool-output histories retain substantial cold and append improvements. No machine-dependent timing threshold is enforced.

## Limits

The checksum detects inconsistent saved projections; it is not a signature against somebody who deliberately edits both data and checksum. It requires retaining all independent historical maxima, so cache and worker-transfer costs still grow with owned keys. Reader and checkpoint metadata remain host-private; public usage snapshots contain aggregate projections rather than the resume cache. These measurements do not claim reduced SSH payloads or measured Windows/SSH latency.

One unreadable source prevents a complete provider refresh. Previous completed totals and an error remain visible instead of silently omitting history. On startup, an invalid saved projection is withheld until a successful rebuild. These are deliberate correctness costs.

Bounded head/boundary evidence cannot detect an arbitrary unsampled middle rewrite that also grows a file. The provider transcript contract remains append-only. Same-length changes, replacement, truncation, changed boundary evidence and invalid checkpoints take the full-parse path; there is no new automatic whole-corpus audit or separate history-rebuild UI. No history cap or dropped rows conceal this limitation.

## Reproduce

Run timing tools while builds, tests, apps and other benchmarks are idle. All tools create isolated temporary transcript directories and retain actual parser, projection and filesystem-reader code.

```sh
ORCA_BACKGROUND_LAUNCH=1 ORCA_CLAUDE_USAGE_APPEND_BENCH_BASELINE=51e7181850b022bae2d41091fe1229accef4bd50 ORCA_CLAUDE_USAGE_APPEND_BENCH_ROUNDS=8 node config/scripts/claude-usage-append-benchmark.mjs --compare --verify
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-cache-representation-check.mjs
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-discovery-coverage-check.mjs
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-hardening-cost-benchmark.mjs --usage-keys 16384 --rounds 8
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-hardening-cost-benchmark.mjs --usage-keys 100000 --rounds 4
```

The new tools accept `--baseline-ref` and `--output`. The canonical tool takes its baseline and round count through the environment variables shown above. POSIX commands can be run through an equivalent environment-variable launcher on Windows; the real permission check reports its Windows limitation instead of treating a successful read as denial coverage.
