# Smaller saved Claude usage data

The previous PR used more disk to remember previously counted usage. This follow-up losslessly compresses only the worker-owned source cache with asynchronous gzip level 1. The displayed report, every historical total, integrity checks and atomic file-write sequence stay intact.

| Test history                      | Main disk | Previous PR disk | Compressed disk | Main update | Previous PR update | Compressed update |
| --------------------------------- | --------: | ---------------: | --------------: | ----------: | -----------------: | ----------------: |
| 16,384 repeated entries           |    472 KB |           539 KB |           84 KB |       60 ms |              28 ms |             30 ms |
| 100,000 distinct entries          |   2.98 MB |          6.13 MB |         1.60 MB |      260 ms |              83 ms |             97 ms |
| 100,000 less-compressible entries |   6.80 MB |         10.46 MB |         5.39 MB |      276 ms |             103 ms |            224 ms |

Decimal sizes include the saved source cache and report. Each row uses six counterbalanced rounds of the complete measured processing/persistence path, checked against a full recount. Baselines are main `b44a5796` and published PR `4102ea91`. These are fixture measurements, not whole-app latency or a universal disk-size guarantee.

Compression trades CPU for space. Full rebuilds measured 82 vs main's 62 ms, 410 vs 261 ms, and 533 vs 281 ms in these three fixtures. Unchanged refreshes measured 13 vs 22 ms, 37 vs 38 ms, and 60 vs 47 ms. Less-compressible data can therefore slow unchanged refreshes despite saving space. Unchanged source caches still incur zero writes.

Small caches stay plain. Compression is kept only when smaller than this PR's plain representation. Sources exceeding 128 MiB stay plain, preserving history and existing cache reuse. Compressed reads validate the decoded size, bound expansion, and then apply the same independent source integrity checks. Truncation, corruption, inconsistent concatenated output and forged sizes are rejected. Existing plain caches remain readable. Older Orca versions skip the optional compressed source cache and can rebuild it; their independently valid displayed report remains available. Writes capture their destination and workspace binding before awaiting compression. A test changes the caller's binding mid-write and verifies that only the original destination is written. No public wire format changes.

[Evidence receipt](./claude-source-compression-receipt.json) links raw samples and source hashes. Earlier measurement files describe the previous uncompressed implementation and remain historical evidence. Integration with current main updates benchmark subprocess imports to the existing `@orca/process-host` package; captured source and tooling hashes retain their original measurement provenance.

Reproduce:

```bash
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-source-compression-benchmark.mjs --usage-keys 16384 --maxima-pattern repeated --rounds 6
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-source-compression-benchmark.mjs --usage-keys 100000 --maxima-pattern unique --rounds 6
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/claude-usage-source-compression-benchmark.mjs --usage-keys 100000 --maxima-pattern varied --rounds 6
```
