# Completed SSH writes retained behind a rolling backlog

The SSH multiplexer lane scheduler advanced its read index without clearing consumed entries. A lane that stayed nonempty retained every completed `WriterEntry`, its encoded buffer and its settlement callback. The writer had already released those entries from its byte and frame counters, so admission limits did not bound this consumed prefix. Fully draining the lane or disposing the multiplexer released it.

The fix clears the selected slot and compacts a consumed prefix after at least 1,024 selections when it occupies at least half the array. This follows the existing `RelayFrameBuffer` pattern. Lane ordering, fairness, admission limits, transport settlement and in-flight ownership are unchanged. `clear()` returns only remaining live entries.

## Actual caller and ownership

The ordinary-lane proof executes `writeToSshPtyWithSettlement` → `SshChannelMultiplexer.notifyWithSettlement` → `SshMultiplexerTransportWriter` → `SshMultiplexerWriterLaneScheduler`. `SshPtyProvider` exposes the same helper through its RPC operations. The control-lane proof uses the `git.responseAck` notification shape emitted by `requestGitStreamable`.

`ssh-relay-deploy-helpers.ts` connects transport writes and settlement callbacks to `channel.stdin.write`, and registers its `drain` event. A producer that keeps at least one queued entry behind repeated backpressure/drain cycles reaches the retained-prefix state. The proof exercises both a controlled callback/drain port and a real Node `Writable` with a deferred write callback and a synthetic 16 KiB high-water mark. No SSH connection, app, window or remote process is launched.

Selecting an entry transfers scheduler custody to the writer's in-flight set. Clearing its consumed queue slot does not complete the write. A separate control disposes with an in-flight and a queued write: their existing results remain `unverifiable` and `refused`, respectively. The native callback can still retain the in-flight buffer until that callback reference is released. Late and duplicate callbacks do not settle it twice.

## Results

Both captured runtimes produce the same counts: Node 26.6 and Electron 43.7 / Node 24.21. Each runs six scenarios before and after the fix.

| Scenario at the controlled pause                                        |   Original |   Fixed |
| ----------------------------------------------------------------------- | ---------: | ------: |
| Ordinary lane: completed buffers and settlement callbacks retained      | 2,048 each |       0 |
| Control lane: completed buffers and settlement callbacks retained       | 2,048 each |       0 |
| Physical queue slots after those selections                             |      2,050 |       2 |
| Logical queued ordinary frames / bytes                                  |    2 / 706 | 2 / 706 |
| Logical queued control frames / bytes                                   |    2 / 184 | 2 / 184 |
| Real writable: retained written buffers, including one in flight        |        128 |       1 |
| In-flight buffer retained after disposal while native callback is owned |          1 |       1 |
| Written buffers retained after complete drain or final callback release |          0 |       0 |

The real-writable scenario completes 128 writes, starts the 129th and keeps two further writes queued. The first write preceded the rolling backlog and is collectible in both variants; the original therefore retains 127 completed buffers plus the in-flight one. Its logical budget is three frames / 49,440 bytes in both variants. Empty slots below the compaction threshold are expected and do not retain those buffers.

The scenarios assert FIFO order, isolation of ordinary/control counters, full-drain and disposal cleanup. Five permanent lifetime regressions plus 26 existing tests pass. The original-source overlay fails the four rolling-backlog regressions and passes the other 27 tests. Existing tests cover control priority and starvation prevention, liveness bypass, synchronous drain, callback errors and duplicates, overflow, disposal, timeouts and slow-but-live transport handling. See `validation.json` for commands and full-publication quality checks.

## Reproduce

From the repository root after dependency installation:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=192 docs/audits/ssh-writer-consumed-prefix/reproduce.cjs
```

For Electron, run the installed Electron executable with `ELECTRON_RUN_AS_NODE=1` and `ORCA_BACKGROUND_LAUNCH=1`, passing the same flags and script path. This is a Node-mode process with no UI. The runner has a 20-second deadline.

An optional final argument selects the report destination, for example `notes/ssh-writer-consumed-prefix/reviewer-node.json`. Without it, the runner refreshes the corresponding artifact `node-results.json` or `electron-results.json`.

`sources.cjs` reverses `fix.patch` in memory and verifies both original and fixed SHA-256 hashes. It also verifies all nine bundled source dependencies against the recorded hashes. No source file is rewritten. A synthetic CRLF read of the patch and source must reproduce identical canonical LF sources and hashes. `before.config.mjs` uses the same source loader for the original-source test overlay.

## Source compatibility and scope

`source-versions.json` records the exact scheduler baseline at the pre-fix audit commit, independent main `291b4ddd6f1c1af480169885e0fda7f9c78ff053`, and v1.4.198 `e0826956fcfc532f5a1e55b5e081f2e57e553c43`. These scheduler sources are byte-identical after LF normalization, so the same patch yields the same fixed hash. All nine bundled sources and three additional caller sources match independent main. The projected main change has no dependency on the other memory-audit fixes.

The v1.4.198 scheduler is identical, and its writer contains the same enqueue/select/release path. Seven of the twelve dependency/caller files differ from current source; this artifact does not claim to execute the packaged historical release.

Inputs and timing are controlled fixtures. Reachability counts establish the code-level retention mechanism; they do not measure affected-host RSS, model a reported growth rate, or establish that an incident had a continuously nonempty SSH write lane. Active pending writes, transport-owned callbacks and retained primitive sequence timestamps remain governed by their existing limits and lifecycles.
