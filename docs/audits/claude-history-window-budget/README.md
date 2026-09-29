# Claude history-window read quota

Restart reconciliation's Claude history reader declares a 16 MiB source quota, but the original `stat` followed by unrestricted `readFile` admits later growth. Reuse `readNodeFileWithinLimit` to enforce the same quota while reading from one descriptor. Overflow preserves the existing inconsistent-history result; it cannot establish that a submitted message was absent.

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/claude-history-window-budget/reproduce.mjs
```

The seven-case fixture calls the actual history reader, branch proof and bounded reader against real temporary files. It injects an append immediately after the relevant size snapshot. The baseline reverses only `fix.patch` in a temporary Vite transform, leaving the checkout unchanged. Each child has a 45-second timeout and a 512 MiB old-space ceiling. No application window or provider process starts.

| Case                                                      | Before                                         | After                                                                   |
| --------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| 305-byte valid source grows to 17 MiB after size snapshot | Reads 17,825,792 bytes and accepts the history | Stops after 16,777,217 bytes, rejects history and closes its descriptor |
| Stable valid source                                       | Accepted                                       | Accepted                                                                |
| Exactly 16 MiB                                            | Accepted                                       | Accepted                                                                |
| Initially 16 MiB plus one byte                            | Rejected before content read                   | Same                                                                    |
| Growth within quota                                       | Reads the additional bytes and accepts         | Same                                                                    |
| Read error                                                | Inconsistent history                           | Same; descriptor closed                                                 |
| Missing anchor                                            | No source read                                 | Same                                                                    |

Before: one failing fixed-behavior assertion and six passing controls. After: seven passing cases. `results.json` records observed read bytes, size snapshots, descriptor counts, source hashes, exit codes and timeout status. These are read-budget measurements, not RSS or retained-heap measurements; the byte quota does not describe all parser allocations.

This reader is **absent from v1.4.198**, so the finding cannot explain #19768 or #19831. It fixes a current-source quota race. The separately unrestricted `proveClaudeTranscriptBranch` file reader has no declared byte quota and is outside this change. The related legacy-import quota race is already addressed by #20976.
