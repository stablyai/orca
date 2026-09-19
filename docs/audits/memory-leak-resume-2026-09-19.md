# Memory leak audit continuation — 2026-09-19

## Scope and checkpoint

Resumed the earlier audit with `memory-leak-audit` and `memory-leak-debugging`,
using parallel backend, renderer and lifecycle reviews. The selection rule was
to prefer cleanup that preserves behavior, identify substantial tradeoffs, and
leave areas with active PRs alone.

The original `OrcaWin/np-oom-scan` branch contained the historical patch stack,
including already published changes. It remains preserved. This worktree now
uses `OrcaWin/np-oom-resume-2026-09-19`, based on `origin/main` at
`6a7d86ef50dd699c23353b2e64ba261a9fb3344c`. The 35 pre-existing staged audit files
were preserved. No production fix from this continuation is retained, and no
PR was opened, updated or merged.

## Findings deferred because of active PRs

| Finding                                                    | Retention mechanism                                                                                                                                                                                              | Candidate correction and remaining review                                                                                                                                                                                                   | Active area                                                                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native-chat clipboard previews outlive the composer        | `use-native-chat-composer-attachments.ts` revokes Blob URLs on remove/clear/drop, but has no unmount cleanup. Its scope cache deliberately strips preview URLs, so remount cannot release the old registrations. | Release owned Blob URLs when their composer retires. Preserve settled path/connection cache entries, pending-save behavior and StrictMode replay. Do not add an attachment quota as part of cleanup.                                        | [#21483](https://github.com/stablyai/orca/pull/21483) edits the hook; [#17797](https://github.com/stablyai/orca/pull/17797) also changes attachment ownership. |
| Relay responses eagerly allocate base64 for every chunk    | `git-response-stream.ts` builds a complete encoded array before the acknowledged sender admits chunks. A paused sender retains the unsent encoded response.                                                      | Encode each admitted chunk from the payload. Check actual retention and throughput against the existing response framing, ordering and admission behavior. This removes redundant eager encoding, not the payload or every transport queue. | [#11061](https://github.com/stablyai/orca/pull/11061) edits the implementation and ownership tests.                                                            |
| Scrcpy retains diagnostics that it never reports           | `scrcpy-stream-session.ts` concatenates server stdout/stderr for the process lifetime; the exit diagnostic only uses `serverLog.slice(0, 1000).trim()`.                                                          | Retain an owned prefix of the same first 1,000 UTF-16 units. Preserve chunk decoding and the exact exit diagnostic. Full logs beyond that prefix are already unobservable through this consumer.                                            | [#10548](https://github.com/stablyai/orca/pull/10548) edits this file, its test and the video registry.                                                        |
| Browser page chrome inset metadata survives explicit close | `browser-page-viewport.ts` stores per-page inset values. Recovery intentionally needs them, while explicit close can retire them.                                                                                | Tie deletion to explicit page retirement. Preserve recovery and replacement guest ownership. Values are small metadata; no material OOM impact was measured.                                                                                | [#20764](https://github.com/stablyai/orca/pull/20764) edits `webview-registry.ts`, the relevant retirement owner.                                              |

An additional relay presence leak is also deferred to
[#10548](https://github.com/stablyai/orca/pull/10548):
`workspace-session-handler.ts` applies its 45-second client expiry only to the
namespace currently queried. Abandoned namespaces, including empty maps,
remain in `clientsByNamespace`. Sweeping other namespaces could release that
metadata, but sweeping every namespace on every heartbeat adds work and was
not accepted as universally cost-free. The historical prototype commit
`b812912d8d` was not brought onto this branch. The PR changes both the handler
and its test, verified through the REST file list (page 11, 100 files per page).

The overlap check is about the files being changed, not a claim that those PRs
already fix each finding. Read-only PR state and exact heads are recorded in
[the checkpoint](memory-leak-resume-2026-09-19/pr-checkpoint.json).

## Rejected and unproven leads

- **AI Vault scanner shutdown:** experimental ready-waiter rejection and
  retirement tracking were discarded. The shared production scanner has no
  `dispose()` caller beyond the test reset, and its child handles parent IPC
  disconnect. No continuing allocation growth was demonstrated. A kill-request
  deadline is not physical-exit evidence. Quit integration also overlaps
  [#18205](https://github.com/stablyai/orca/pull/18205).
- **Pairing hydration waiters:** survival across pairing churn can be
  intentional; changes would need ownership evidence and overlap
  [#21175](https://github.com/stablyai/orca/pull/21175).
- **Structured-session status owners:** persistent owner/snapshot entries are
  an audit lead, not enough evidence to remove state or add reader-side rules.
- **Unsent attachment volume:** one mounted composer can retain many unsent
  images. A new count/byte quota changes accepted user input and is distinct
  from releasing previews after unmount. No quota was introduced.

## Coverage without a new confirmed fix

The renderer pass reviewed direct `createObjectURL`, `createImageBitmap`, Blob
and canvas/data-URL owners. Feedback drafts release previews on remove, clear
and unmount. Editor image caches have entry/byte bounds and leases; browser and
emulator streams release replaced/stale/current frames; the pet cache evicts
URLs and closes bitmaps. These controls do not prove that arbitrary image
workloads have a fixed total memory cost.

The additional backend pass checked subprocess-output accumulation,
abort-listener cleanup, plugin verification/panel ownership, advertised URL
buffers, observability retention and desktop snapshot storage. Examples of
existing protections include plugin verification reset on refresh, bounded
panel sessions, bounded Git sampling buckets, and screenshot removal from
cached desktop snapshots. No independent, behavior-preserving OOM correction
was established by this targeted pass. This is not an exhaustive whole-program
proof of bounded allocation.

## Prior PR status refreshed

Of the 26 PRs still open at the September 17 handoff, nine have since merged:
[#20908](https://github.com/stablyai/orca/pull/20908),
[#20909](https://github.com/stablyai/orca/pull/20909),
[#21001](https://github.com/stablyai/orca/pull/21001),
[#21005](https://github.com/stablyai/orca/pull/21005),
[#21006](https://github.com/stablyai/orca/pull/21006),
[#21009](https://github.com/stablyai/orca/pull/21009),
[#21024](https://github.com/stablyai/orca/pull/21024),
[#21128](https://github.com/stablyai/orca/pull/21128), and
[#21167](https://github.com/stablyai/orca/pull/21167).
The other 17 remain open, as does the later cleanup extraction
[#21401](https://github.com/stablyai/orca/pull/21401).

The [September 18 tradeoff review](memory-pr-tradeoff-review-2026-09-18.md)
remains the implementation/evidence reference for those PRs. Their current CI
and merge readiness were not re-certified here. In particular, terminal
backpressure can stall a producer, CDP limits can disconnect a slow client,
speech limits can stop dictation, and terminal cache limits can add repeated
work. Those are meaningful policies, not cost-free lifecycle cleanup.

## Evidence limits and next work

The [real-hook reproduction](memory-leak-resume-2026-09-19/native-chat-preview-retention.test.tsx)
imports the production composer attachment hook and mounts it in happy-dom.
Ten mount/begin/resolve/unmount cycles leave ten 1 KiB Blob URLs registered
(10,240 bytes); one pending unmount leaves an eleventh (11,264 bytes total).
Remount restores the settled path with no preview URL. The remove and clear
controls release their 1,024 and 2,048 bytes respectively. The fixture revokes
all remaining URLs afterward. These are registered Blob sizes through Node's
URL registry, not Chromium RSS or heap measurements.

Set `ORCA_BACKGROUND_LAUNCH=1` and run
`pnpm exec vitest run --config docs/audits/memory-leak-resume-2026-09-19/vitest.config.ts`.
The packaged fixture passes one evidence test, explicitly asserting current
retention; it is not a claim that a fix passes a regression test. Its configuration
keeps it outside the ordinary test suite. Source hashes and results are in
[the reproduction record](memory-leak-resume-2026-09-19/preview-retention-result.json).

Formatting and the focused evidence test pass. The changed-code quality check
has no findings in the new artifacts, but fails on four findings in the
pre-existing staged September 18 evidence: `curly` in
`readers/stream-projection-control.cjs:16` and
`readers/readfile-growth-control.cjs:14`, and `prefer-template` in the latter
at lines 59 and 75. Those earlier artifacts remain untouched. No full app
typecheck or cross-platform UI validation is claimed for this documentation-only
continuation.

Chrome heap-debugging tools are unavailable in this session. No raw heap
snapshot was loaded and no affected-host capture was collected. Static paths
and controlled reproductions do not establish the cause of incident #19831.
No visible Electron app was launched; tests use `ORCA_BACKGROUND_LAUNCH=1`.

The next independent fix should be selected after the overlapping PRs settle,
starting with composer preview ownership or the unused scrcpy log suffix.
Any relay optimization still needs stalled-consumer allocation measurements
and output/throughput parity. The scanner shutdown prototype is rejected
evidence, not a patch ready to revive.
