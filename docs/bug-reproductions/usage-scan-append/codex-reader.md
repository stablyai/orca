# Verified transcript reads and Codex usage memory

Codex could verify one file generation, reopen a replacement, and publish old
totals under the replacement's metadata. A short parse could also publish a
partial result as a complete file. Unchanged refreshes then reused those totals.

The shared JSONL reader now pins verification, parsing and checkpoint creation
to one descriptor and the initial file size. It proves complete range consumption
and validates generation and byte evidence before publishing. Stable short reads
propagate errors; only evidence that the file changed permits a retry. Each failed
attempt closes its handle. Metadata-less caches reparse once.

Codex folds owned records into the existing session/day accumulator while reading.
It commits ownership after validation, and lets unchanged forks reclaim keys that
an owner actually loses. Deferred records still advance cumulative token context.
This removes intermediate event arrays while preserving all history and results.

## Reproduce and verify

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm test src/main/codex-usage src/main/usage
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/codex-usage-parser-memory-benchmark.mjs --baseline-ref 51e7181850b022bae2d41091fe1229accef4bd50 --events 100000 --pairs 2 --sample-ms 35 --output docs/bug-reproductions/usage-scan-append/codex-parser-memory.json
```

The final [memory comparison](./codex-parser-memory.json) bundles the full parser
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
