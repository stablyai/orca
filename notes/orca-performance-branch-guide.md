# orca-performance Branch Guide

Agent-facing map of every optimization on this branch: what it does, why it exists,
where it lives, and the invariants you must not break when adding to it. The
chronological evidence trail (benchmarks, retractions, A/B protocols) is in
`notes/terminal-performance-initiative.md`; this doc is the _current-state_ view.

**Context**: Orca's terminal was ~300× slower than Terminal.app under agent load
(DSR-under-load p50 134ms, p99 292ms on v1.4.91; agent-TUI throughput 2.0 MB/s).
As of v1.4.122-rc.1.perf: p50 13.3ms / p99 18.7ms, zero timeouts, throughput
11.8–15.5 MB/s — beats VS Code on 5 of 6 metrics. Goal line still open: 4.5ms
(10× Terminal.app).

## The pipeline

```
shell → pty → daemon (persistence, headless model) → unix socket
     → main (ipc/pty.ts: batching, delivery gate, flow control, snapshots)
     → IPC → renderer (pty-dispatcher → pty-connection → output scheduler → xterm)
```

Main is on the hot path for every byte (unlike VS Code's ptyHost→renderer
MessagePort). The daemon owns sessions so they survive app restarts; it also runs
a headless xterm emulator per pty — the _model_ — which is the source of truth
for screen contents. The renderer terminal is a _view_ that can be discarded and
rebuilt from model snapshots.

## Optimization inventory

### 1. Renderer parse-path fixes (the original 16× on agent TUIs)

- **Parse-clocked scheduler drains** (`pane-terminal-output-scheduler.ts`): drain
  cadence follows xterm's actual parse completion instead of fixed timers, so the
  queue never outruns the parser.
- **Windowed retained-tail redraw**: TUI repaints (erase-down + redraw) only
  re-process a bounded window instead of the full retained tail. Guarded by
  differential fuzz `retained-tail-redraw-window.equivalence.test.ts`.
- **Throttled wait-blocked check** (`orca-runtime.ts`): the per-chunk agent
  wait-detection (two 256KB waitText builds + multi-pattern scans) now runs at
  50ms cadence with trailing edge + keyword pre-filter. Was ~85% of main's
  per-chunk cost.

### 2. term-speed-2 chain (model/view contract — the architecture)

Revived from ~38 never-merged branches; kill-switched, default ON. Docs:
`docs/reference/terminal-model-view-contract.md`.

- **Hidden view parking**: hidden tabs tear down their xterm view entirely
  (memory: parked panes cost ~0).
- **Hidden delivery gate** (main): renderer-bound bytes for hidden ptys are
  dropped at main — hidden panes receive nothing. Reveal rebuilds the view from a
  model snapshot + live chunks after the snapshot's seq.
- **Side-effect authority**: main extracts side-effect facts (bell, title, cwd)
  from the model so parked panes stay live in the UI without a view.
- **Model query authority**: main answers terminal queries (DSR/CPR, DA1, OSC
  colors) deterministically from the model for hidden panes.
- **Seq/ordered-delivery bookkeeping**: every chunk carries a seq; reveal
  reconciliation drops duplicates already covered by the snapshot baseline.

### 3. Batching & scheduling cadence

- **Batch windows 8ms → 2ms** in both `daemon-stream-data-batcher.ts`
  (`STREAM_DATA_BATCH_INTERVAL_MS`) and `ipc/pty.ts` (`PTY_BATCH_INTERVAL_MS`).
  At 9% utilization there is no queue — latency was literally the sum of fixed
  batch windows. This one change took dev DSR-load 19→8ms.
- **MessageChannel zero-delay drains** (`pane-terminal-output-scheduler.ts`):
  Chromium clamps nested `setTimeout(0)` to ~4ms; posted messages are macrotasks
  without the clamp, preserving cooperative yield (input/paint still serviced).
  Vitest keeps the timer path (fake timers can't advance channel posts).
- **Input write coalescing** (from main, #7205): renderer input writes coalesce
  instead of queuing macrotask-per-keystroke.

### 4. Backpressure (the correctness spine — read before touching delivery)

Three cooperating layers, innermost first:

- **ACK at parse-drain** (`deliverPtyDataWithDeferredAck`, scheduler
  `ackCredit`): the renderer credits a chunk when xterm has _parsed_ it (or the
  chunk is legitimately discarded), not when IPC delivered it.
  **INVARIANT: every delivered chunk credits exactly once — parsed or
  discarded.** Every scheduler/pty-connection discard path (backlog replacement,
  disposed terminal, reconcile drop, split remainders) must fire the credit.
- **Cumulative ACKs + solicited resync** (`terminal-pty-ack-gate.ts`,
  `applyCumulativeAck` in pty.ts): ACKs carry monotonic per-pty processed totals
  (TCP-style); main max-merges, so lost ACKs self-heal. Data arriving for a
  fully-gated pty triggers a resync probe instead of a timeout reset. The only
  timer is a hygiene warn that mutates nothing. Main's 512KB per-pty in-flight
  gate + 2MB pendingData cap sit on top.
- **Renderer-pull delivery watchdog** (`terminal-delivery-watchdog.ts`,
  `pty:reportRendererDeliveryState` in pty.ts): recovers the field-confirmed
  wedge where every main→renderer PUSH channel dies while invoke stays alive
  (v1.4.121-rc.0 snapshot; electron#37067 class) — a state the push-ridden
  resync probe can never reach. The 15s heartbeat costs one Map upsert per
  received chunk and does no IPC while output flows; mutation stays
  verified-state-only (the timer decides when to REPORT; the write-off derives
  entirely from the renderer's cumulative received totals, never wall-clock,
  and a received-but-unparsed window is never written off). Heal = re-attach
  push listeners + pull restore markers through the modelRestoreNeeded router.
  E2e blackhole harness: `__terminalDeliveryWatchdog`,
  `terminal-push-delivery-loss-recovery.spec.ts`.
- **Stale-visibility proof for the hidden gate** (`stale-document-visibility.ts`
  and the `shouldWritePtyOutputForeground` fallthrough in pty-connection.ts):
  recovers the field-confirmed wedge where macOS occlusion tracking pins
  `document.visibilityState` at `'hidden'` after display sleep and never fires
  another visibilitychange (v1.4.124-rc.2.perf snapshot: 78MB hidden-gate
  dropped across 2 pane-level-visible ptys, transport healthy). Real user
  input (keydown/pointerdown/window focus) while the document claims hidden is
  a physical contradiction — it latches an override, runs each pane's existing
  visibilitychange resync (gate unhide + hidden-output restore), and a genuine
  visibilitychange hands authority back. No timers; recovery is purely
  event-proven, and the failure bias is safe (a wrong override only restores
  pre-gate delivery cost, never drops bytes). Hot-path cost: zero when
  visible (same single comparison); one property read per user-interaction
  event. E2e: `terminal-stuck-occlusion-recovery.spec.ts` (pins both the
  freeze repro and the keystroke recovery, plus the
  `hiddenDeliveryGatedVisiblePtyCount` field discriminator).
- **One-paste freeze report** (`terminal-freeze-report.ts`, prod-installed
  `await window.__orcaTerminalFreezeReport()`): a single DevTools command that
  returns renderer state (visibilityState + stale override, pty:data listener
  count, watchdog totals), main's snapshot with a per-pty delivery table
  (sent/acked/pending, hidden vs visible-set membership, last send/ACK ages,
  window focus flags, power suspend/resume ages, app version), and bounded
  breadcrumb rings from BOTH processes (`pty-delivery-diagnostics.ts` shared
  ring: 100 entries, same-kind coalescing) recording gate marks, visibility
  trust changes, watchdog stalls/heals, restore markers, heal write-offs,
  renderer lifecycle resets. Pty ids are redacted to their `@@` suffix —
  daemon session ids embed worktree paths. Recording happens only on rare
  transitions; the table/report is built only when read. This exists so a
  field freeze report never needs a follow-up ask.
- **Hidden/parked exit teardown completeness** (pty-connection.ts kept-exit
  guard + `terminal-parked-tab-watchers.ts` exit sidecar): two invariants that
  keep a split pane's death near the hidden/park boundary from stranding state
  (field incident: a closed setup-split leaf persisted in `root` with no
  binding and remounted as a permanently blank pane, unreachable by
  dead-session reconcile — it skips ptyId-null panes by design).
  (1) The "keep a fresh split whose newborn PTY died" branch is **gated on
  `isVisibleRef`** — hidden panes' bytes are gate-withheld, so "no output"
  proves nothing there; a hidden newborn death must `closePane`, or the kept
  pane becomes a binding-less ghost. (2) A PTY exit that lands **while parked**
  reaches ONLY the parked watcher's exit sidecar (hosts' `onPtyExit` needs a
  mounted TerminalPane), so the sidecar itself collapses the dead leaf out of
  the stored layout via `detachTerminalLayoutLeaf` — a stale binding left
  behind reattaches on reveal and the daemon re-creates the exited session id
  as a fresh shell (silent pane resurrection). E2e:
  `terminal-pane-close-layout-consistency.spec.ts` sweeps close/exit at every
  lifecycle phase and asserts leaves(root) == bindings == live panes.
- **Producer flow control** (protocol v19 `pausePty`/`resumePty`, 256KB pause /
  32KB resume watermarks, keyed off **pendingData only** — never renderer
  counters; kill switch `PRODUCER_FLOW_CONTROL_ENABLED`, ipc/pty.ts): when main's
  buffer grows, the _shell_ blocks. For main-hosted ptys pause is synchronous
  (drops impossible); for daemon ptys the pause notify has ~20-30ms socket
  latency, so wire-speed bursts can still cross the 2MB cap (known follow-up:
  daemon-side self-pacing watermark).
- **Shallow stream-socket write gate + per-session fairness**
  (`daemon-stream-data-batcher.ts`, 128KB gate / 64KB safe-split slices /
  4KB small-session bypass / 32MB write-through valve; kill switch
  `ORCA_DAEMON_SHALLOW_SOCKET_GATE=0`): the stream socket is one FIFO for
  every session — bytes already written can never be overtaken, so a deep
  user-space buffer buries a visible pane's echo behind other panes' bulk
  (measured 192MB / 6+s under 12 flooding hidden agents). Bulk writes stop at
  the gate and hold in the batcher, where the interactive flushSession path
  and the deterministic small-session bypass still jump them; socket `drain`
  refills. This layer alone bounds echo latency by the shallow depth.
- **Background keep-tail stream thinning + daemon fact authority**
  (`daemon-stream-keep-tail-drop.ts` 1MB cap / 512KB keep-tail,
  `daemon-background-transient-facts.ts`; kill switch
  `ORCA_DAEMON_BACKGROUND_STREAM_DROP=0`): hidden-gated ptys are exempt from
  pendingData flow control (main drops their bytes after ingestion), which
  let N background agents run unbounded ahead of main. Main mirrors the
  hidden-delivery gate to the daemon via the wire-tolerated
  `setSessionBackground` notification (introduced in v19; authoritative
  thinning requires v20 snapshots, so preserved v19 sessions are explicitly
  unthinned; older daemons swallow it) — but a live remote view subscriber
  (mobile/web) vetoes backgrounding (`hasRemoteTerminalViewSubscriber`).
  Backgrounded sessions' queued output is keep-tail dropped (oldest bytes
  replaced by an in-order `dataGap` event; reply-eliciting query bytes are
  salvaged so hidden programs never hang on DSR/DA replies); producers are NEVER paused,
  so reveal stays instant with zero catch-up. Un-background neither discards
  nor force-flushes the queued tail — restore paths read MAIN's model
  (hidden-output recovery buffer), so a discarded tail loses a finished
  program's last output forever (caught by the ACK-backpressure e2e), and a
  16-pane force-flush dumps ~12MB onto the socket ahead of the reveal's own
  bytes; the ordered drain loop delivers it within the budget below. Two
  aggregate bounds make that budget real: (1) a GLOBAL background keep
  budget (~2MB): per-session keep-tails shrink (512KB → floor 64KB) as more
  backgrounded sessions hold queued data, and tighten retroactively when the
  count grows — without this, N sub-cap sessions queue N×cap and a worktree
  switch waits seconds behind the aggregate (measured 9MB → 2.5s hidden
  restore vs the 1.5s budget, probe-verified drain overlap); (2) a
  kernel-flush refill sentinel: a held flush pass arms one ~90B empty data
  event whose write callback re-flushes when the kernel accepts the
  in-flight bytes — without it, held bulk advances one gate-depth per
  'drain' (user-space empty) per event-loop turn (~8MB/s ceiling on a busy
  daemon). NOTE: an empty `socket.write('')`'s callback fires immediately
  even with megabytes buffered (verified) — the sentinel must be a real
  protocol no-op line. Notifications are
  structurally lossless: while backgrounded, the DAEMON runs the same shared
  scanners main uses (`terminal-output-side-effects.ts`: bell / OSC 133
  command-finished / pr-link / DECSET 2031) over every byte BEFORE drop
  decisions and relays facts as in-order `transientFact` events; ordered
  `sessionBackgroundMarker` events hand scan authority back and forth
  (main suppresses just those four scanners in between), and the emulator's
  `partialEscapeTailAnsi` seeds each side's fresh scanner carry so a
  sequence split across the handoff neither phantom-fires nor goes missing.
  Titles/agent-status stay main-side (they converge from the kept tail and
  fuse with synthetic spinner frames). On `dataGap`, main resets its
  cross-chunk parse carries, drops the mobile headless mirror (rebuilds from
  tail/seeds), and sends the model-restore-needed marker so any
  renderer-side buffer heals from the snapshot. Visible ptys are never
  touched by this layer. Backlog observability:
  `ORCA_DAEMON_STREAM_BACKLOG_FILE=<path>` JSONL
  (`daemon-stream-backlog-probe.ts`; events incl. `backgroundKeepTailDrop`,
  `setSessionBackground`, `mainBackgroundSync`, `heldWriteThrough`).
  Causation A/B (`bench:multi-workspace-typing`): realistic steady rates
  (8×192KB/s) don't reproduce even fix-off; burst rates on a loaded machine
  do (8×512KB/s + 12 CPU spinners: fix-off p50 293ms/p90 647ms → fix-on p50
  29ms); extreme 12×1MB/s: fix-off p50 6,146ms → 29ms.

### 5. Flood resilience (why bulk output can't wedge or lie anymore)

- **Restore-loop cut** (pty-connection.ts): the hidden-output-restore loop
  abandons immediately when a foreground pane's live-chunk queue overflows
  (3-iteration hard cap), and a 2s flood-suppression window stops main's own
  backpressure drops (`droppedOutput`/`modelRestoreNeeded`) from re-arming
  restore — bytes write through, ONE deferred repaint heals after the flood.
  This killed a positive feedback loop (restore starves ACKs → main drops →
  drop re-arms restore) that caused multi-second renderer stalls.
- **Query survival**: if the 2MB cap ever drops bulk output, embedded terminal
  queries are extracted (`terminal-reply-query-extraction.ts`) and answered by
  _synthesizing replies on the input path_ (CPR from live buffer, DA1 canned,
  OSC via direct responder) — probes and TUIs never hang on a dropped reply.
- Drops are downstream of the model: the daemon ingests every byte, so the
  post-flood repaint restores complete, correct content.

### 6. Wake/sleep recovery

- powerMonitor resume → `system:resumed` IPC → renderer wake recovery (fixes
  WebGL-latch blank-after-sleep that DOM focus/visibilitychange missed).
- Cumulative ACKs make the historical "lost ACKs across suspend pin the global
  window forever" wedge (BMW user bug) structurally impossible.

### 7. Snapshot fidelity (the garble fixes — all fuzz-pinned)

Reveal-from-snapshot multiplied exposure of serializer defects ~1000×. Five bugs
found by differential fuzzing; four fixed, one tolerated:

- **B: SGR intensity ordering** — upstream `@xterm/addon-serialize` emitted
  `1;22` (22 clears the bold 1 just set). Patched via pnpm patch
  (`config/patches/@xterm__addon-serialize@*.patch`): clear-before-set for the
  bold/dim group (+2 sibling bare-22 defects).
- **C: cursor off-by-one at wrap-pending margin** — bypassed entirely:
  `serializeWithAbsoluteCursor` (`terminal-serialize-absolute-cursor.ts`)
  appends absolute CUP from the source terminal's authoritative cursor
  (skipped when wrap-pending, where CUP would corrupt).
- **D: DECSC saved-cursor register not serialized** — snapshot appends
  `CUP(saved) + ESC 7 + CUP(actual)` when a register exists.
- **E: snapshot mid-escape-sequence** (fired on 24% of fuzz corpus) —
  `terminal-partial-escape-tail.ts` is a fold-safe VT-parser-state scanner; the
  unparsed tail ships as `TerminalSnapshot.pendingEscapeTailAnsi` and is written
  LAST on restore so continuation bytes complete the sequence. Seq accounting
  unchanged (the tail is a suffix of bytes ≤ snapshot seq).
- **A (tolerated)**: upstream wrap-null-cell serialize defect — fenced by
  `bufferHasSerializeHostileWrappedRow`, the only remaining tolerance.

## Correctness infrastructure (run these before merging delivery/restore changes)

- `headless-emulator-fidelity.fuzz.test.ts` — differential: HeadlessEmulator vs
  reference xterm, seeded TUI streams. `FUZZ_ITERATIONS=2000` for deep,
  `FUZZ_SEED=n` to replay.
- `hidden-reveal-reconciliation.fuzz.test.ts` — property tests: random
  hide/reveal boundaries × snapshot seq × racing chunks must equal an
  always-visible reference.
- `terminal-snapshot-serialize-roundtrip.test.ts` — the garble repros (unskipped
  = regression alarms).
- e2e: `terminal-hidden-view-parking` (incl. 25-cycle park/reveal drift test —
  byte-identical vs control), `terminal-parked-memory`,
  `terminal-sleep-wake-restore`.
- Scheduler credit-invariant + ack-gate deferred-credit + restore-flood tests
  (pane-manager / terminal-pane suites).

## Benchmarking protocol (hard-won rules)

- Rig: `tools/benchmarks/terminal-pipeline-bench.mjs` — DSR idle + DSR under
  1MB/s agent-TUI load + DSR-fenced throughput on 4 fixtures. Run _inside_ the
  terminal under test.
- Multi-workspace typing rig: `pnpm bench:multi-workspace-typing -- --panes 12
--rate-kbps 1024 --keys 32 --cadence-ms 250 [--cpu-workers 8] --label <build>`
  — real keystrokes (CDP) into a visible pane while N hidden-worktree panes
  replay paced agent-TUI streams through real daemon ptys; decomposes each key
  into input-half (keydown→pty, sidecar timestamps) and echo-half
  (pty→screen). JSON in `tools/benchmarks/results/`. Noise band at 4×256KB/s:
  p50 10-15ms, p90 ≤50ms. The latency signature lives in echo-half; renderer
  timer drift staying ~15ms while echo-half grows means the backlog is
  upstream of the renderer (daemon socket / main ingest).
- **Bench at 10MB** (`--size-mb 10`). The ACK-at-parse bug shipped because dev
  benches used 3MB and never tripped the cap.
- Load-controlled A/B only: alternate builds within one session; dev carries ~2×
  day-to-day variance. Never conclude from runs while agents/builds hammer the
  machine (two false convictions came from this).
- Never set `ORCA_E2E_USER_DATA_DIR` for benches (arms the e2e ACK gate → hang).
- Packaged builds are truth; dev has ~2× overhead.

## Release mechanics

- Perf RCs: `release-cut.yml` workflow_dispatch, `kind=rc ref=orca-performance
version_suffix=perf` → tags like `v1.4.122-rc.1.perf`. The suffix sorts above
  its base rc.N but below rc.N+1 (never hijacks the RC channel). The rc counter
  (`release-rc-history.mjs`), telemetry identity classifier, and build guard are
  all suffix-aware — a suffixed rc classifies as `rc`.
- cmd/ctrl-click "Check for Updates" fetches the latest perf-tagged release
  (PR #7278; merged here) — perf-line users self-update after one manual install.

## Syncing with main: MERGE, never rebase

`orca-performance` is a long-lived, shared, continuously-pushed integration
branch — RCs are cut from it and agents branch off it. **Always
`git merge origin/main`; never rebase** (rebasing rewrites pushed history and
strands every RC tag, fix branch, and worktree based on the old commits).
Conflict pattern, established over ~6 syncs:

1. **Our structure wins; main's semantics graft in.** This branch deliberately
   restructures terminal code (shared scanners, single-policy handlers,
   model/view split). When main adds a feature inside code we've restructured,
   keep our shape and port their new behavior into it. Example: main inlined an
   OSC 133 parser to add `onCommandStarted` (133;C); we kept the shared
   `createOsc133CommandFinishedScanner` (main's side-effect tracker must parse
   byte-identically) and added 133;C support to the shared scanner instead.
2. Preserve the invariants in **Guardrails** below through every resolution —
   especially chunk-credit, `pendingData`-keyed flow control, and the
   single `handleCommandFinished` policy (byte path AND sideEffect-fact path
   route through it).
3. After resolving: `pnpm typecheck`, the terminal-pane + ipc/pty + daemon
   suites, and both fuzz suites. Commit the merge with a message stating what
   was kept from each side; push. If the push races a moved remote, merge the
   remote tip — never `pull --rebase` a merge.
4. If a sync lands anything on the delivery/restore path, re-run a 10MB bench
   before the next RC cut.

## Known limits / next levers (in rough priority order)

1. Daemon self-pacing: daemon-hosted ptys can cross the 2MB cap for ~20-30ms at
   wire speed before `pausePty` bites. Fix: daemon enforces its own watermark
   locally (VS Code does this server-side for remotes).
2. Cadence floor to the 4.5ms goal: xterm's 12ms parse slices and remaining
   drain cadence dominate the 13.3ms prod p50.
3. utilityProcess router endgame: take main off the per-byte hot path
   (VS Code's ptyHost→renderer MessagePort shape).
4. SerializeAddon full-buffer stalls at 50k-row scrollbacks (#5096 follow-up).
5. Peel PRs to main: throughput fixes → batch+MessageChannel → flow control →
   term-speed-2 last. PR #7214 is the integration overview; #7260 (wake/ACK)
   is open against main separately.

## Guardrails for future agents

- The chunk-credit invariant (§4) is the load-bearing one. If you add ANY path
  that receives, defers, drops, or splits pty data in the renderer, prove it
  credits exactly once. The credit-invariant unit tests are the gate.
- Flow control keys off `pendingData` only. Do not couple it to renderer
  counters; the two layers compose because they are independent.
- Snapshot changes must keep seq semantics: a snapshot covers _exactly_ bytes
  ≤ its seq (Bug E made this true; don't regress it). Chunks after restore are
  reconciled by seq — off-by-N re-triggers duplicate-drop garble.
- Hidden panes must receive nothing (delivery gate) but side-effects and query
  replies must stay live via the model. If you add a new query type, wire it
  through model authority AND the drop-path synthesis.
- Never add timeout-based recovery that mutates counters (user requirement —
  design decision from #7260). Deterministic resync or nothing; hygiene timers
  may only log.
- Any change on the delivery/restore path: run both fuzz suites, the roundtrip
  tests, the chain e2e trio, AND a 10MB bench before calling it done.

## Audit 1

Completed 2026-07-10 against `orca-performance`. Scope: the daemon → main →
renderer terminal path, with particular attention to hidden delivery, parking,
stream thinning, snapshot fidelity, ACK/backpressure semantics, wake/reattach,
mobile/remote composition, SSH routing, and teardown. The audit treated model
state and user scrollback as correctness requirements, not expendable memory.

### Findings and fixes

1. **Hidden-gate handoff owners could undo one another.** A parked watcher and
   an unmounting/remounting pane shared one boolean hidden mark; likewise a
   retiring pane could report `visible=false` after its replacement had already
   reported `visible=true`. Hidden claims are now reference-counted and
   visibility is counted per owner (`pty-renderer-delivery-claims.ts`). Eager
   pre-mount buffers no longer hold raw-byte delivery interest: they are not a
   side-effect consumer, and model-backed hidden output can restore from a
   snapshot. This removes the ownership and eager-interest races formerly
   listed in Known limits item 6 without weakening parked side effects. The
   remaining transient-visibility concern was checked separately: bind and
   reconnect reports read `TerminalPane`'s synchronously refreshed
   `isVisible && isWorktreeActive` ref, the global effect uses the same
   expression, and owner counting prevents a retiring pane from overriding its
   replacement. No hidden-worktree `visible=true` report site remains.

2. **A natural/synthetic daemon exit could overtake final output.** When a
   shallow-gated socket had queued data, `daemon-server.ts` wrote the exit event
   directly. The final bytes could therefore arrive after `exit`. Exit is now an
   ordered control event in `DaemonStreamDataBatcher`; both natural and
   synthetic exits flush through the same FIFO. A deep-socket regression test
   pins final-data-before-exit ordering.

3. **Keep-tail thinning could permanently reduce scrollback to the retained
   tail.** On `dataGap`, main discarded its headless model, then rebuilt it from
   later tail bytes even though the daemon still owned the complete model. Live
   daemon snapshots now carry `outputSequence`; the provider exposes an
   authoritative `getBufferSnapshot`, accepts the requested scrollback depth,
   and main requires that provider snapshot after a gap. Reconciliation starts
   in the pre-snapshot absolute sequence domain and runtime sequence accounting
   advances across dropped bytes. The daemon remains the source of complete
   scrollback instead of making a transport optimization destructive. If that
   authoritative RPC is temporarily unavailable, main now returns no snapshot
   and lets the renderer retry; it never paints main's known-incomplete tail as
   a full recovery.

4. **Query-salvage copies corrupted the absolute sequence domain.** DSR/DA
   bytes salvaged from a dropped region are copies of bytes already counted by
   the daemon, not new output. Stream events now distinguish delivered text
   from `sequenceChars`; salvaged query data advances by zero while the gap
   advances by the original characters. Main can still parse/deliver the query
   copy without shifting every later snapshot baseline.

5. **“Parse-deferred” ACKs were submission-deferred, not parse-deferred.** ACK
   credit fired when bytes entered `terminal.write`, before xterm's callback.
   Split scheduler chunks also attached `onParsed` to the first slice. ACK
   credit is now owned by `pane-terminal-output-ack-credit.ts`, fires after the
   final xterm parse callback, and is released exactly once on throw, discard,
   or terminal disposal. Submitted-but-unparsed credit is retained until parse
   or disposal, so main's flow-control window measures parser work rather than
   renderer submission.

6. **Hidden restore ignored configured scrollback.** The renderer always asked
   for 5,000 rows, so users configured for 10k–50k silently lost older history
   on a hide/reveal rebuild. Restore now reads the pane's xterm scrollback
   option and clamps it through the shared 0–50,000 policy
   (`terminal-hidden-restore-scrollback.ts`).

7. **Active alternate-screen snapshots discarded the normal shell buffer.**
   SerializeAddon emits `normal buffer + ?1049h + alternate buffer`; the old
   normalization sliced away everything before the last `?1049h`. A restored
   TUI looked correct until it exited alternate mode, then returned to empty
   history. Snapshots now carry the normal buffer separately in
   `scrollbackAnsi`. Fresh reattach and mobile/remote snapshot streams compose
   both buffers; an already-alt renderer exits alt, clears/rebuilds the normal
   buffer, then re-enters and rebuilds alt. History replay also composes both
   buffers, including legacy empty-field compatibility.

   Deep fuzz then found a second two-buffer issue: normal-buffer serialization
   can leave its SGR pen active while the separately serialized alternate body
   assumes default SGR. The rehydrate boundary now emits `SGR 0` before
   `?1049h`, preventing a shell color from tinting restored TUI cells. The
   regression proves the TUI is visible immediately and `?1049l` returns to the
   original shell history.

8. **Daemon provider wrappers forwarded only part of the recovery contract.**
   A preserved current/legacy daemon could emit `dataGap` through a provider
   wrapper, but `DegradedDaemonPtyProvider` omitted `getBufferSnapshot`, while
   the ordinary multi-version `DaemonPtyRouter` omitted background hints, gap
   events, snapshots, and explicit `sequenceChars`. Both wrappers now route the
   complete contract to the provider that owns the session, including requested
   50,000-row recovery and zero-advance query-salvage events.

9. **Sequence-safe recovery was added without advancing the daemon protocol.**
   An already-running v19 daemon could accept background-thinning hints but
   could not return the new `outputSequence`, making any resulting gap
   impossible to reconcile safely. The authoritative snapshot contract is now
   protocol v20. Preserved v19 sessions remain live but are explicitly marked
   unthinned; their stale background hint is cleared on the ordered control
   socket before `createOrAttach`, while fresh v20 sessions retain keep-tail
   performance and full-model recovery.

### Static audit conclusions

- Model query authority still captures ownership synchronously at ingestion;
  seed/hydration/snapshot writes remain reply-silent, remote view subscribers
  retain view authority, and replies use the provider input path (including
  daemon shell-ready queuing and SSH routing).
- Hidden/visibility/interest/background-sync/provider-snapshot state is cleared
  by the centralized PTY teardown path. Parked watcher timers, byte sidecars,
  fact consumers, exit subscriptions, hidden claims, and runtime-title slots
  dispose on reveal/exit/worktree shutdown.
- Remote-runtime and SSH PTYs remain excluded from cold parking. SSH hidden
  panes still have a main-owned headless model, so mounted hidden-gate restore
  is valid; live remote viewers veto daemon background thinning. The new
  two-buffer payload is recomposed before mobile/remote snapshot frames.
- Wake recovery keeps its focus/visibility/system-resume listener symmetry and
  cancels its settled animation frame on cleanup. No timeout was added that
  mutates ACK or delivery counters.
- The one documented upstream SerializeAddon null-cell/wrapped-row defect
  remains tolerated. Deep reveal fuzz now uses the same narrow hostile-row
  predicate as fidelity fuzz, rather than misclassifying that known serializer
  defect as sequence-reconciliation loss.

### Validation evidence

- Focused ownership/connection/dispatcher tests: 422 passed.
- Daemon server/batcher/order tests passed, including deep queued-socket exit.
- Broad main/daemon/runtime/RPC/SSH run: 1,854 passed, 5 skipped. Three stale
  mocks were updated to assert the new explicit `sequenceChars` argument; the
  production behavior was already correct.
- Broad renderer terminal/pane/scheduler/runtime-stream run: 1,934 passed.
- Final restore/roundtrip/history/adapter/runtime/scheduler sweep: 1,315 passed.
- Post-protocol completion sweep: 1,106 affected main/daemon tests passed;
  484 renderer/restore tests passed with 2 expected skips.
- Scheduler throughput harness passed with `ORCA_TERMINAL_PERF_BENCH=1`.
- Required hidden-view parking, parked-memory, and sleep/wake E2E trio:
  7 passed on a fresh v20 Electron build, including byte-identical output
  across 25 park/reveal cycles.
- `FUZZ_ITERATIONS=2000` headless-emulator fidelity: passed (120.19s).
- `FUZZ_ITERATIONS=2000` hidden reveal reconciliation: passed (69.77s). It
  reproducibly found the SGR boundary bug at seed 16 and the known upstream
  wrapped-null-cell case at seed 1221 before the final green run.
- Snapshot roundtrip, retained-tail equivalence, ACK gate, PTY connection, and
  remote incomplete-escape regression suites passed.
- Fullscreen real-app headful flow: a real shell wrote normal history, entered
  a TUI while its worktree was hidden, restored on reveal, then exited with
  `?1049l` back to the original history. The BrowserWindow was fullscreen;
  no click/focus occurred before evidence; the restored frame settled for
  1.5s before capture. Measurements: window 1710×1073 at DPR 2; xterm 133×63;
  `fitAddon.proposeDimensions()` 133×63; cell width 8px; screen-to-xterm gap
  11px (the scrollbar/remainder, with grid and proposed dimensions equal).
  Artifacts: `.tmp/terminal-audit-headful/fullscreen-alt-restore.png` and
  `.tmp/terminal-audit-headful/fullscreen-alt-restore-metrics.json`.
- Visible, non-E2E current-build Orca 10MB agent-TUI bench: 10.14 MB/s
  (986ms for 10.0MB), DSR idle p50/p90/p99 0.64/6.47/57.82ms,
  DSR-under-load 6.72/9.86/13.87ms, zero timeouts. The pane was 115×39,
  reported app version 1.4.131-rc.2, and ran on a v20 daemon/session. Result:
  `tools/benchmarks/results/terminal-pipeline-audit-v20-20260710-2026-07-10T10-54-45-990Z.json`.
- `pnpm typecheck`, oxlint on every touched TypeScript file,
  `pnpm check:max-lines-ratchet`, `git diff --check`, and the E2E production
  build all passed. No max-lines bypass was added.
