# Claude transcript branch-proof allocation

Orca verifies the complete conversation ancestry before preserving or resuming a Claude session. This change reads the transcript incrementally instead of keeping the whole file and its split lines in memory. It still checks every record in the observed byte range, including old ancestors and disconnected conflicts. It does not just parse the first line.

## Reproduce

After the repository's normal dependency installation:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc docs/audits/claude-branch-proof-streaming/reproduce.cjs /tmp/claude-branch-streaming-results.json
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/claude-branch-proof-streaming/regressions.mjs /tmp/claude-branch-streaming-regressions.json
```

`diff` is a pinned direct development dependency. The harness reverses `fix.patch` against the checked-out reader in memory and verifies the original reader's SHA-256 before building the comparison. It does not modify production files. esbuild writes temporary modules, which are removed along with their require-cache entries on exit. No window or network access is needed.

The variants in the JSON are:

- `baseline`: the original full-file reader, reconstructed and hash-checked.
- `candidate`: an open-ended streaming experiment retained as a control. It can admit newly appended records and is not the implementation being merged.
- `windowCandidate`: the exact checked-out production reader, including its one internal refresh after descriptor growth.

`results.json` and `electron-results.json` were regenerated against production revision `2e623a227474101160de4c977bfae69da4b052ee`. They record the runtime, tool versions, harness inputs, actual bundled dependencies, production source variants, and bundle hashes. Allocation and duration values vary between runs. `provenance.json` now describes the shipped source; reproduction fails if its source hashes or quoted call-site lines drift.

The obsolete initial-window and open-ended result snapshots were removed because they described a different splitter and reader. Their experimental results remain available in git history. `baseline-initial-results.json` is explicitly historical: its original runtime and complete dependency graph were not captured, so it is not current reproducibility evidence.

## Production behavior

The reader opens the file once, stats that descriptor, and streams a finite range through the existing line splitter. Each message body can be released after parsing; the UUID ancestry graph remains until validation finishes. The existing 10,000-ancestor limit stays unchanged. No transcript quota, record-size cap, eviction, or tail-only proof is introduced.

A valid first range returns immediately, even if a newer marker appears later. When the first range is missing a marker/cursor or ends in an incomplete record, the reader checks the same descriptor's size. If the descriptor size increased, it retries the entire proof once over the enlarged finite range. Already-completed repairs therefore succeed without a caller retry. An unfinished repair can still require the existing caller retry. Conflicting ancestry, invalid sessions, malformed middle records, and append-order errors remain errors.

An increased size does not establish append-only writes or prove that the original prefix stayed unchanged. This is not an atomic filesystem snapshot: in-place overwrites and truncation can affect bytes inside the range, as with the old reader. Failed restat, shrink, and pathname replacement do not prove growth. The original opened descriptor is always closed before the production reader returns or throws.

## Reachability

`provenance.json` records exact source hashes and call sites for the current implementation and reported release v1.4.198:

- The local structured Claude runtime adapter resolves the account's transcript and delegates to the full branch proof through `session-file-resolver.ts`.
- Closing a structured session reads the transcript after connection close, before persisting the handle. A proof failure preserves the previously observed leaf. Unexpected-exit persistence uses the same reader.
- The resumed-PTY verifier calls the full reader and retries incomplete-tail errors on its existing 100 ms cadence, within a 15-second deadline. Static absence and invalid history remain fatal there.

These paths already used unrestricted full-file reads in v1.4.198. Rewind handling is newer than that release. The audit establishes source reachability and synthetic allocation reduction; it does not establish a user's transcript size, the number of concurrent readers, or the cause of a reported production OOM.

## Evidence and limits

Both recorded runtime audits pass 51 static real-file cases across all file/string APIs, 24 growth and cleanup controls, and 10 actual-verifier cases. Growth controls inject append, replace, delete, shrink, stat-error, and read-error events against real files. The three completed-repair verifier cases now succeed on the first caller attempt. Static absence, conflicts, session mismatches, and append-order failures retain their error behavior.

The harness checks the original `FileHandle` for closure. Historical readers without an exposed handle also check descriptor identity, avoiding false leak reports when the OS reuses a closed descriptor number. The fixture uses a private Node filesystem binding only for deterministic timing; production uses public APIs.

`regression-results.json` records 68 resolver, rewind, recovery, and history-window tests passing on each of the three variants (204 tests). The focused production run also passed all 26 streaming tests: 94 tests across the five relevant files in total. Tests were run on macOS arm64; this does not claim a Windows/Linux or live SSH integration run.

The 32 MiB allocation fixture uses 64 message bodies of 512 KiB with realistic identifiers. The current Electron audit measures about **34.6 MB** additional sampled live heap for the original reader and **1.1 MB** for the production reader. Both release almost all of that allocation after returning. Sampling forces GC at actual `JSON.parse` boundaries; it is not RSS, a natural peak, or evidence of a retained leak. GC noise can make retained deltas negative.

A single 8 MiB record still needs about **16.8 MB** under every variant. The identifier graph still grows with record count. This removes whole-transcript payload retention; it is not a total memory cap.

The separate duration control reads one stable 2.79 MB file with 8,193 small records, using two warm rounds and five measured rounds in alternating order without forced GC during timing. Electron medians were **4.9 ms before** and **7.37 ms after**. These are synthetic per-run observations, not a throughput guarantee or a timing gate.

`electron-results.json` uses installed Electron 43.7.0 / Node 24.21.0 in Node-only mode, with no app/window launch:

```sh
ELECTRON_RUN_AS_NODE=1 ORCA_BACKGROUND_LAUNCH=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --expose-gc docs/audits/claude-branch-proof-streaming/reproduce.cjs /tmp/claude-branch-streaming-electron.json
```

Other platforms use their installed Electron executable with the same environment and arguments. This is compatibility evidence for the installed runtime, not the historical Electron binary.
