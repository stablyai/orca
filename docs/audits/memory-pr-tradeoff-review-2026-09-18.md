# Memory PR tradeoff review — 2026-09-18

## Scope and result

Three parallel agents and the primary reviewer revisited all 17 PRs held for behavior or performance tradeoffs. Nine size-only holds were outside this pass. No PR was merged.

We found a separate lifecycle fix with no identified user-facing tradeoff, removed unnecessary behavior changes from two existing PRs, and corrected one overly broad warning. A promising terminal hyperlink optimization was rejected after repeated benchmarks exposed new density-dependent regressions. None of the remaining full PRs is represented as universally cost-free.

## All 17 decisions

| PR                                                                                | Outcome                                                                             | Remaining behavior or performance cost                                                                            |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [#20947](https://github.com/stablyai/orca/pull/20947) daemon stream backlog       | Separate cleanup extracted as [#21401](https://github.com/stablyai/orca/pull/21401) | The original backpressure PR can still pause live PTY producers.                                                  |
| [#20949](https://github.com/stablyai/orca/pull/20949) CDP queue                   | No verified replacement                                                             | Slow clients can be disconnected; general CDP events/results have no lossless replay owner.                       |
| [#20955](https://github.com/stablyai/orca/pull/20955) hyperlink retirement        | Faster sparse prototype rejected after dense regressions                            | Periodic cleanup work remains.                                                                                    |
| [#20963](https://github.com/stablyai/orca/pull/20963) transcript record budget    | No verified replacement                                                             | Complete records over 10 MiB are rejected and can leave a session incomplete.                                     |
| [#20965](https://github.com/stablyai/orca/pull/20965) invisible glyph cache       | No verified replacement                                                             | Evicted keys need recomputation on revisit.                                                                       |
| [#20976](https://github.com/stablyai/orca/pull/20976) legacy import budget        | No verified replacement                                                             | An import growing past 16 MiB can fail.                                                                           |
| [#20981](https://github.com/stablyai/orca/pull/20981) contrast cache              | No verified replacement                                                             | Evicted colors need recomputation on revisit.                                                                     |
| [#20992](https://github.com/stablyai/orca/pull/20992) erased backing strings      | No reliable faster replacement                                                      | Five cleanup variants, including the published implementation, did not establish removal of the parser penalty.   |
| [#21014](https://github.com/stablyai/orca/pull/21014) stale PTY inventory         | No safe replacement                                                                 | Lifecycle races can require retry; treating stale inventory as current could affect successor processes.          |
| [#21020](https://github.com/stablyai/orca/pull/21020) acknowledged tab retirement | No safe replacement                                                                 | A stale/unconfirmed close can require retry; accepting it could close new work or falsely claim success.          |
| [#21021](https://github.com/stablyai/orca/pull/21021) history budget              | No verified replacement                                                             | Growth past the existing 16 MiB quota can fail reconciliation.                                                    |
| [#21024](https://github.com/stablyai/orca/pull/21024) streamed ancestry proof     | No verified replacement                                                             | Markers appended beyond the initial read extent can require retry.                                                |
| [#21128](https://github.com/stablyai/orca/pull/21128) crash dump reader           | Updated: preserve native opened-prefix behavior                                     | Dumps already over 64 MiB at descriptor stat remain rejected, including earlier growth/replacement.               |
| [#21129](https://github.com/stablyai/orca/pull/21129) speech backlog              | No verified replacement                                                             | Overload stops capture and can lose speech/final output; stopping a live microphone cannot preserve future audio. |
| [#21175](https://github.com/stablyai/orca/pull/21175) removed host partitions     | Normal GUI warning withdrawn after source/identity controls                         | Direct stale-ID IPC/manual restoration was not proven equivalent; prerequisite and review gates remain.           |
| [#21178](https://github.com/stablyai/orca/pull/21178) closed editor models        | Updated: preserve existing bounded view caches                                      | Large-file, raw Windows-drive URI and budget-evicted undo can still be lost.                                      |
| [#21185](https://github.com/stablyai/orca/pull/21185) plugin log retirement       | No verified replacement                                                             | Uninstalled-plugin history is removed; preserving every retired ring restores unbounded owner retention.          |

## Published code

### #21401: retired daemon refill ownership

64 production lines and 122 test lines changed; the PR contains no audit bundle. Clearing a disconnected client now releases its refill token immediately. A late socket callback cannot flush or disarm a replacement using the same client ID. It reuses the existing `DaemonStreamHeldRefill` implementation; live queue/backpressure policy and protocol frames are unchanged.

Exact main baseline fails three of four lifecycle controls, including 200 retained client IDs. The candidate passes 31 tests across three suites, both lint configurations, and focused TypeScript 7 checks over its roots and 247 exact-source imports. All 303 evaluated test-source hashes were verified. Socket-owned callback allocations themselves remain governed by socket completion.

### #21128: remove an unnecessary crash-dump refusal

The caller opts into reading the initial nonempty regular-file extent. Growth after descriptor stat no longer rejects that valid prefix or causes growth-copy allocations. The default helper behavior and synchronous reader are unchanged. Shrinking files return only initialized bytes; zero-size sources still use bounded EOF reads.

56 tests across five suites pass; unchanged production fails the two new controls. Four-file ordinary/anti-slop lint, focused TypeScript 7 and independent review pass. Final tested-to-published difference is one explanatory comment. This is not an atomic snapshot against in-place rewriting and does not eliminate the descriptor-time size policy.

### #21178: preserve view state while releasing models

The app-shell lifetime now retires models without wiping the existing scroll, selection, diff and PDF caches. Their existing 20-entry policies remain; this is an entry bound, not a strict byte bound. Explicit combined model/cache disposal callers retain their behavior. Registry generation, exact model identity, live/reopened/shared URI ownership and attachment/detachment fences remain unchanged.

43 tests across eight suites, five-path ordinary/anti-slop lint and scoped TypeScript pass. Independent review found no ownership regression. Full web typecheck reports one inherited unused import in `NativeChatMessageList.windowing.test.tsx:12`, byte-identical to the earlier PR head. The final publication adds only a comment correction after those checks.

Real Monaco controls narrow the previous undo warning: small POSIX/file-URI reopen can retain undo via Monaco's existing 20 MiB closed-file budget, with a 10 MiB file-size eligibility limit and matching content. Raw Windows-drive URIs and large-file/budget cases still lose undo. These are programmatic model controls, not visible UI validation.

### #20955: optimization deliberately not published

The sparse extended-cell prototype made plain/sparse sweeps substantially faster, but its first form regressed dense rows. A density heuristic reduced that problem; repeated runs still found roughly 1.0–1.3% slowdown on densely linked rows with an unlinked midpoint, and a 5.9% slowdown for one prefix-density case in one run (the other two were faster). The user requested removal of tradeoffs, so this workload-dependent substitution was rejected. The original PR is unchanged.

Correctness controls preserve live links, saved attributes, wide/combined cells and erased cells; independent review additionally requested a dictionary-shape guard for private xterm metadata. Passing those controls does not erase the measured performance cost. The experimental sources, all benchmark runs and review notes remain local evidence.

## Why several alternatives did not qualify

- **Live queues:** finite retention cannot preserve unlimited undelivered input, uninterrupted producer progress and bounded resources simultaneously. Terminal snapshots/history have bounded windows and omit transient events. CDP `ReturnAsStream` only helps specific requested results. Disk spill moves cost to storage and I/O; graceful speech draining still stops future capture and cannot drain a permanently hung decoder.
- **Cache bounds:** exact published cache-method controls revisit 4,097 distinct keys. The old cache has zero revisit misses; the 4,096-entry cache has 4,097. This proves a repeated-work case, not GPU/rasterization latency. A different eviction policy cannot promise a hit for every unbounded revisit sequence.
- **JSON projection:** the existing streaming parser is useful for container retention, but selected paths and partial tokens still retain a complete ignored scalar. Two controls each retain all 12 MiB of an ignored string. Existing full-record callbacks and message/journal arrays need a deeper streaming contract before removing the admission guards safely. Moving the existing Codex prefix classifier ahead of assembly is a plausible partial improvement for known ignored record types, but remains unverified: framing, consumer, offset and unterminated-tail parity are required, and the general cap would remain.
- **File extent:** real Node 26.6 and Electron 43.7 / Node 24.21 controls show nonempty Buffer reads stop at their initial extent; large UTF-8 reads can include concurrent appends. The binary crash fix therefore does not justify dismissing the UTF-8 ancestry retry. Following a growing stream until EOF can add unbounded work, latency or graph growth.
- **History consistency:** exact prompt text/fingerprints and complete ancestry matter to reconciliation. A bounded prefix cannot establish that an unobserved message is absent. Streaming decoders/transactional journal or graph redesigns remain possible research directions; no parity-proven local replacement was found here.
- **Removed hosts:** ordinary remove/re-add creates a new UUID even before #21175, so the old partition was already unreachable through that new host. Updating an existing pairing preserves its UUID; profile moves carry owning repositories and stay guarded; mounted removed-host views already purge on catalog updates. This supports withdrawing the normal-GUI warning, not a claim about every manually restored identity.
- **Plugin history:** a preserve-history/rotate-token experiment fences late callbacks but retains all eight tested retired 200-row rings. Published cleanup releases all eight. The existing bounded security audit log has different content and cannot substitute for arbitrary plugin stdout history.

## Evidence and limits

Exact published-head controls also pass for #20947 (35), #20949 (6, including real localhost sockets), #21129 (15), #21014 (18), #21020 (11), and #21175 (16 retirement tests plus pairing controls). Negative controls and rejected alternatives remain documented; they are not counted as successful fixes.

The [evidence index](memory-pr-tradeoff-review-2026-09-18/evidence-index.json) records exact commits, local artifact paths and SHA-256 hashes. The permanent regression tests are in their individual PRs. Detailed local evidence is under `notes/tradeoff-removal/{queues,xterm,lifecycle,readers}`; it is intentionally not copied wholesale into implementation PRs.

All tests/apps used `ORCA_BACKGROUND_LAUNCH=1`; Electron ran only as Node for the native read control. No visible app was launched. Full cross-platform, SSH mixed-version, native speech, GPU and affected-host validation are not claimed. No host capture exists for #19831; these are code mechanisms and behavior controls, not incident attribution. Published heads were verified open at the expected commits. CI for #21401, #21128 and #21178 was pending at the final checkpoint; the unchanged #20955 and #21175 heads already had failing CI. Current PR CI remains a merge gate.
