# Verified transcript reads and Codex usage memory

Codex could verify one file generation, reopen a replacement, and publish old
totals under the replacement's metadata. A short parse could also publish a
partial result as a complete file. Unchanged refreshes then reused those totals.

The shared JSONL reader now pins verification, parsing and checkpoint creation
to one descriptor and the initial file size. It proves complete range consumption
and validates generation and byte evidence before publishing. Stable short reads
propagate errors; only evidence that the file changed permits a retry. Each failed
attempt closes its handle. A successful attempt closes before ownership publication
and aggregate work. Metadata-less caches reparse once.

Codex folds owned records into the existing session/day accumulator while reading.
It commits ownership after validation, and lets unchanged forks reclaim keys that
an owner actually loses. Deferred records still advance cumulative token context.
This removes intermediate event arrays while preserving all history and results.

## Reproduce and verify

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm test src/main/codex-usage src/main/usage
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/codex-usage-parser-memory-benchmark.mjs --baseline-ref 51e7181850b022bae2d41091fe1229accef4bd50 --events 100000 --pairs 2 --sample-ms 35 --output docs/bug-reproductions/usage-scan-append/codex-parser-memory.json
```

The original [memory comparison](./codex-parser-memory.json) bundles the full parser
dependency graph from the named baseline and current worktree. Two counterbalanced
rounds use fresh Node workers and record source/tool hashes and raw forced-GC
snapshots. Every arm preserves identical projections, owned keys and token totals.

| Owned records             | Baseline sampled retained heap | Current sampled retained heap |
| ------------------------- | -----------------------------: | ----------------------------: |
| 100,000                   |                  44.7–45.0 MiB |                   8.0–9.1 MiB |
| 10,000, with 90% deferred |                  3.69–3.75 MiB |                 1.23–1.25 MiB |

Final result retention stays approximately 6.49 → 6.51 MiB for all owned records:
the result still contains the full history. Timer samples miss synchronous peaks,
and forced GC affects timing; these figures measure sampled retained heap rather
than total process memory or speed.

Real-file regressions cover replacement, truncation, rewrite, suffix resume,
partial tails, stable short reads, failed ownership publication, old-cache upgrade
and handle cleanup. Local checks used macOS; CI covers Linux and Windows.
The shared aggregation compatibility suites also passed for Muse and OpenCode.

Head and committed-boundary digests support the append-only contract. They cannot
prove arbitrary middle-only rewrites during growth. Small changed files receive
a full verification reread; unchanged files read no transcript bytes.

The companion Claude PR adopts this reader. The original integrated validation
and benchmarks were recorded from a combined worktree; production source remains
identical when split into PRs.

## Adversarial hardening

Tiny files now use bounded descriptor reads and exact byte comparison for both
passes. This avoids creating a stream without reducing verification. Exact bigint
device/inode values prevent large Windows file IDs from colliding after numeric
rounding; unsafe persisted offsets fall back to a complete parse.

Discovery distinguishes a directory that disappeared from one that cannot be
read. Missing children leave readable siblings available. Permission and I/O
errors abort the refresh, retaining the previous verified totals and showing the
existing error state rather than publishing incomplete totals.

A [counterbalanced ten-round comparison](./shared-reader-small-files.json) of the published reader and hardened
reader over 1,000 tiny files measured median scanner cold time 85.024 → 80.529 ms
and changed time 91.512 → 84.092 ms. Both arms read the same bytes twice; streams
fell from 1,000 to zero. Unchanged scans read zero bytes in both arms and measured
7.808 → 8.241 ms. These page-cache-warm macOS timings are observations, not CI
thresholds or a claim about the original pre-verification reader.

Regression contracts exercise short reads, exact comparison, unsafe offsets,
large file identities, fractional timestamps, and discovery failures. The
original retained-heap artifact above predates this hardening; its source hashes
describe that earlier measurement, rather than the final reader.

## Further risk reduction

The [refreshed memory comparison](./codex-parser-memory-final.json) captures the
final parser and reader source. Its two counterbalanced rounds use eight fresh
Node workers and preserve exact output parity with the original baseline.

| Owned records             | Original sampled retained heap | Final sampled retained heap |
| ------------------------- | -----------------------------: | --------------------------: |
| 100,000                   |                43.87–44.54 MiB |               8.07–8.30 MiB |
| 10,000, with 90% deferred |                  4.53–4.58 MiB |             1.231–1.235 MiB |

The median reductions are approximately 81.5% and 72.9%. Final output retention
stays similar or slightly higher: 6.49 → 6.53–6.55 MiB for owned events, and
0.975 → 1.005–1.014 MiB for deferred events. These are forced-GC samples, not
absolute peaks, full-app memory, or speed measurements.

Real-file lifetime contracts cover both tiny and streamed transcripts. They
prove the descriptor is closed before an ownership callback replaces the path,
the verified old projection keeps its captured metadata, and the next parse
observes the replacement. Failure cases check cleanup when validation fails or
the first close attempt rejects before reaching the native close.

This shortens Windows replacement contention to reading and validation; parsing
can still include asynchronous attribution while the descriptor is pinned.
Ordinary append writes remain compatible. Tiny verification still reads the full
file twice, and bounded append evidence retains its append-only assumption.
