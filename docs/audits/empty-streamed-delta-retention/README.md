# Empty streamed deltas retain array entries

The text coalescer charged streamed text by UTF-8 bytes but appended an array entry for every empty delta. A live stream receiving repeated empty updates could retain an increasing number of entries while both byte counters stayed zero. Flushing published a joined string and kept the entries. The actual Codex notification path accepts `delta: ''`; this diagnostic exercises its stream handler and coalescer.

The fix skips only the empty `chunks.push` operation. Empty-stream creation, snapshots, dirty state, scheduled publication, callback receiver, backpressure and eviction remain unchanged.

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/empty-streamed-delta-retention/reproduce.cjs
```

The runner reverses hash-checked patches in memory and checks every bundled source dependency. It changes no product files and starts no native process or UI. A bounded CRLF control checks source and patch loading. Reports were recorded on Node 26.6.0 and Electron 43.7.0's Node 24.21.0.

| Control                                                              | Before                         | Fixed                     |
| -------------------------------------------------------------------- | ------------------------------ | ------------------------- |
| Four batches of 16,384 empty Codex deltas, flushing each batch       | 16,384 → 65,536 retained slots | 0 slots after every batch |
| Logical stream count                                                 | 1                              | 1                         |
| Accounted / observed text bytes                                      | 0 / 0                          | 0 / 0                     |
| Scheduled callbacks / published rows in the complete caller scenario | 6 / 5                          | 6 / 5                     |
| Append `hé` after empty updates                                      | Same 3-byte text               | Same 3-byte text          |
| Forget and disposal                                                  | Clear retained state           | Clear retained state      |

The runner compares the entire recorded publication and scheduling behavior before/after. Controls also cover first-empty snapshots, failed publication and retry, rejection of a new empty key while the previous stream is backpressured, accepted eviction, callback receiver, UTF-8 truncation and an empty update after truncation. The two runtimes each execute four source phases: current/main before and fixed, plus the v1.4.198 coalescer before and with the same narrow guard.

The permanent regression invokes the actual Codex stream caller. A temporary `Array.prototype.join` observer measures the matching chunk array only during synchronous snapshot creation, then restores the method. The baseline fails with 65,537 slots versus the expected single nonempty prefix; the other 14 coalescer controls pass. All 64 focused compatibility tests pass with the fix. See [validation.json](./validation.json).

## Source and incident scope

The current baseline is byte-identical to the coalescer at named main commit `291b4ddd6f1c1af480169885e0fda7f9c78ff053`. The exact v1.4.198 coalescer contains the same unconditional empty append; its surrounding implementation differs. Historical phases replace only that module and use the recorded current Codex caller/dependencies. This is a source overlay, not a packaged historical application replay. [source-versions.json](./source-versions.json) records these distinctions and named caller hashes.

Claude's generic checkpoint API also uses the coalescer, but its ordinary provider path rejects empty text in `claude-streamed-block-identity.ts` before calling it. This artifact demonstrates the Codex path and preserves Claude compatibility; it does not claim an ordinary Claude trigger.

Measurement instrumentation reads private map and array cardinalities without changing their contents. These are retained-entry counts, not heap, RSS or byte measurements. The fixture keeps the live stream owned until forget/disposal; it does not establish retention after all owners collect. Nonempty one-byte deltas can still have substantial array overhead within the text-byte allowance, and overflow concatenation has its own transient cost.

No affected-host data establishes how often Codex emitted empty updates in #19831 or another incident. The finding is a reproducible code-level growth mechanism present in the reported release. It does not attribute an app-scope OOM total to this mechanism or establish its incident magnitude. No remote protocol, process liveness, process termination or terminal ownership behavior changes.
