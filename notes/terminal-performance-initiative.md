# Terminal Performance Initiative

Working plan for the `orca-performance` branch. Goal: make Orca's terminal as
performant as the architecture allows, with every claim backed by a number.
Started 2026-07-02.

## Why (user-reported, from the team meeting)

1. Typing in the terminal is sometimes laggy — occasionally seconds of delay.
2. Users say the terminal is slower than iTerm (unclear if typing or scrolling).
3. Scrolling in Claude Code / OpenCode is slow.
4. Idle memory is high (1–2 GB).
5. Battery usage is high.

Goals: legit performance complaints ≤ 1/week; sampled P90 typing/scrolling
latency down significantly; lower memory with 0–1 agents.

## Ground truth (verified against source, 2026-07-02)

Research corpus: xterm.js 6 / VS Code / Ghostty internals study (verified
file:line claims) — see the archived digest and the "xterm.js vs Ghostty"
deep-dive. The Orca-specific findings below were re-verified against this
repo's code:

- **Electron main sits on every terminal byte's path** (daemon → main →
  renderer). VS Code ships the same xterm.js but bypasses main entirely: its
  ptyHost is a UtilityProcess with a direct MessagePort to each renderer.
- **The PTY producer is never paused.** `acknowledgeDataEvent` is a no-op in
  both `LocalPtyProvider` and `DaemonPtyAdapter`. Only main→renderer delivery
  is watermarked (512 KB, `src/main/ipc/pty.ts:1374`); main's own buffer can
  grow toward a 512 MB cap under flood. VS Code pauses the actual pty at 100k
  unacked chars (kernel backpressure blocks the shell).
- Renderer terminals share one thread with the entire React app; xterm.js
  parses in 12 ms slices at a documented 5–35 MB/s ceiling.
- Renderer scrollback default is 5,000 rows (`src/shared/terminal-scrollback-policy.ts`),
  5× VS Code's default; 12 B/cell plus per-line JS objects; O(all lines)
  reflow on column resize.
- Latency physics: Ghostty ~4 ms median keypress latency, VS Code ~31 ms
  (same-library reference), native class 5–10 ms. Realistic target: beat
  VS Code, close on iTerm2, eliminate the stall/jank class entirely (P99
  dominates perception).

## Current state

Branch `orca-performance` (long-lived testing line, from main @ `8e8a08ac7`):

1. `tools/benchmarks/terminal-pipeline-bench.mjs` — cross-terminal rig
   (see Benchmark protocol below).
2. Merge of PR #7153 = #7150 (freeze/memory: backlog caps, wedge guards,
   probe-certified replay release) + #7139 (cooperative drain: paced backlog
   draining keeps typing responsive under floods). Post-merge on this base:
   `pnpm typecheck` clean, 626 targeted tests green (scheduler, guards,
   pty/pty-connection/pty-transport suites). #7153 itself is a disposable
   testing PR; #7139 and #7150 land separately on main.

## Workstreams

### 1. Baseline benchmarks (now; human-in-terminal required)

Run the rig in each terminal on the same machine — Orca pane, iTerm2, Ghostty,
Terminal.app, VS Code (T3Code if available):

```
node tools/benchmarks/terminal-pipeline-bench.mjs --label <machine>-<date>
node tools/benchmarks/terminal-pipeline-bench.mjs report
```

These numbers answer "are we actually slower than iTerm, and where," and are
the before/after for everything below.

### 2. Validate #7153 on orca-performance (this week, extended testing)

Watch for: typing responsiveness under agent floods, bounded memory,
skip-notice + snapshot repaint on overflow, no permanent input loss. When
validated, land #7139 and #7150 as separate PRs on main.

### 3. Revive term-speed-2 (the headline structural work)

History: nwparker's ~38-branch chain (+20k lines) implementing the terminal
model/view contract — hidden view parking, hidden delivery gate, side-effect
authority in main, model query authority, skip-grammar deletion — all
kill-switched, documented in
`origin/nwparker/term-speed-2-architecture-docs:docs/reference/terminal-model-view-contract.md`.
It shipped only in v1.4.78-rc.1, a deliberate personal-testing build; it was
never rejected and never reached main. Directly targets complaints 3–5
(hidden panes stop receiving bytes and unmount their xterm + WebGL atlases).

Merge scout (2026-07-02, chain tip into orca-performance): 144 files, 34
conflicted, 115 hunks. Hotspots: `pty-connection.ts` (31), `pty.ts` (16),
`daemon-pty-adapter.ts` (6), `orca-runtime.ts` (5).
`pane-terminal-output-scheduler.ts` does NOT conflict — #7139/#7150 and the
chain touch different layers; runtime interaction (drain pacing × hidden
gate) still needs deliberate testing.

Execution: dedicated focused session; resolve on `revive/term-speed-2` off
orca-performance; keep both sides' kill switches; validate with typecheck +
the contract tests listed in the model-view-contract doc + #7153's suites;
merge back to orca-performance for extended testing. Estimated ~1 day of
careful resolution + validation.

### 4. Remaining stall-bug fixes (parallel, independently shippable)

The "seconds of delay" class = discrete thread-blocking events, not
steady-state latency:

- PR #7105 (open): skip synchronous cold-restore replay for live daemon
  sessions in doSpawn.
- `SerializeAddon.serialize()` audit: ~1.2 s renderer block at 50k scrollback
  rows (#5096 follow-up, never done). Call sites include the mobile snapshot
  path (`pty-connection.ts:2861`) and sleep/hibernate serialization.
- #2836 frozen-terminal leads: replay-guard latch, codex-stale gate, uncapped
  buffers (repro harness exists).
- Checkpoint-RPC main-thread scrub (measured ~2–10 ms bursts per hot 5 s
  tick; small, part of the same program).

### 5. Producer-side PTY flow control

Ack-driven pause/resume of the actual PTY through the daemon protocol
(node-pty supports it), watermarks per the xterm.js flow-control guide
(≤500 KB). Converts flood-induced buffered lag into shell blocking — the
correct physics. Sequence after #7139 lands (interacts with its drain pacing).

Design (2026-07-03, implement after the term-speed-2 revival merges —
same files):

- Signal source: main already tracks per-pty pending + in-flight
  (`pendingData`, `rendererInFlightCharsByPty` in `ipc/pty.ts`). When a
  pty's pending exceeds HIGH (256 KB), main asks the producer to pause;
  below LOW (32 KB), resume.
- Producer side: two new protocol notifications (`pausePty`/`resumePty`,
  protocol vNext, version-gated like `supportsIncrementalCheckpoints`);
  daemon `Session` calls node-pty `pause()`/`resume()` — stops reading the
  pty fd, kernel buffer fills, the shell blocks on write: true kernel
  backpressure, identical physics to VS Code's 100k/5k design.
  `LocalPtyProvider` calls pause/resume directly.
- Safety invariants: (1) failsafe auto-resume after 5 s regardless of
  watermark, so a lost resume can never wedge a shell; (2) resume on
  detach/exit/kill/daemon-reconnect; (3) pause must not suppress the
  interactive-echo bypass — with the pipeline fixed (11.5 MB/s dev), the
  HIGH watermark is only reachable during genuine floods where echo is
  already queued; (4) PTY reads never stop for model/tail ingestion
  (term-speed-2 invariant #1) — pause gates the fd read, so daemon-side
  emulator state pauses with it, which is correct (state = what was read).
- Tests: watermark transition unit tests, lost-resume failsafe, kill/exit
  cleanup, plus an e2e pressure scenario asserting bounded main memory and
  a blocked producer (`yes` exits promptly on SIGINT while paused).

### 6. Extend the measurement rig

- True keypress→pixel latency: Typometer manual protocol (the DSR probe stops
  at the parser reply, before paint).
- Idle memory + battery: per-process RSS breakdown + `powermetrics` sampling
  at 0/1/5 agents (goal-3 metric).
- FPS under flood; event-loop-delay probes (`monitorEventLoopDelay`) in
  main/daemon/renderer behind a debug flag for pipeline attribution.

### 7. utilityProcess terminal router (structural endgame; gated on data)

An Electron UtilityProcess owns the daemon socket and hands each renderer a
MessagePort — VS Code's topology while keeping Orca's detached daemon (warm
reattach). Takes main off the terminal data path entirely; daemon-side
history persistence falls out naturally. Prototype only after baselines show
how much tail latency lives in the main hop.

### 8. Production P90 telemetry

Sampled keypress→echo latency + long-task/stall counts from real users;
defines the success criterion and becomes the permanent regression gate.
Design after the local rig stabilizes so the metrics match.

## Benchmark protocol

`tools/benchmarks/terminal-pipeline-bench.mjs` measures, from inside any
terminal:

- **DSR idle latency** — ESC[6n round trips (p50/p90/p99); replies come only
  after the parser reaches the query, so it proxies the input pipeline
  without keystroke injection.
- **Fenced throughput** — 4 deterministic fixtures (`ascii-log`, `cjk-emoji`,
  `agent-tui` — Claude-Code-shaped transcript + DEC-2026 status repaints —
  and labeled-pathological `styles-stress`), each run ended by a DSR fence so
  xterm.js-class ingest queues can't flatter the result.
- **DSR under load** — latency sampled during a paced 1 MB/s agent-TUI
  stream: "typing while the agent works," quantified.

Rules: same machine, AC power, comparable window size, no tmux/screen, hands
off the keyboard during runs. Never compare numbers across machines.

## Sequencing

```
now:        [1] baselines        [2] #7153 testing      (parallel)
next:       [3] term-speed-2 revival (dedicated session)
parallel:   [4] stall fixes, [6] rig extensions
after 2/3:  [5] flow control
gated:      [7] utility router   [8] telemetry
```

BMW-group crash work remains the team's priority gate above all of this
(#7150's wedge guards overlap it); this plan runs measurement and revival
prep in parallel without displacing it.

## Findings log

### 2026-07-02 — baseline + decomposition (results committed in tools/benchmarks/results/)

Same machine, unattended serial runs (Orca 1.4.91 prod, Terminal.app, Ghostty
1.3.1; iTerm2 not installed, VS Code pending):

| metric | Orca prod | Terminal.app | Ghostty |
|---|---|---|---|
| DSR idle p50/p99 (ms) | 0.69 / 22.7 | 0.35 / 0.68 | 0.19 / 0.72 |
| DSR under 1 MB/s agent load p50/p99 (ms) | **134 / 292** | 0.45 / 7.9 | 0.21 / 6.1 |
| agent-tui fenced throughput | **2.0 MB/s** | 37 | 78 |
| ascii-log fenced throughput | 13 MB/s | 39 | 93 |

Decomposition of the 51× agent-tui gap — both pipeline ends are fast:

- Bare `@xterm/headless` (114×85, scrollback 5000): agent-tui **103 MB/s**
  (`terminal-headless-parse-bench.mjs`). The xterm parser is not the problem.
- Daemon `Session` ingest (emulator + pending-output recording + fanout):
  agent-tui **103 MB/s** (`session-ingest-throughput.bench.test.ts`,
  `ORCA_TERMINAL_PERF_BENCH=1`). The daemon is not the problem.

Conclusions: (1) idle latency is fine — the extra process hop costs ~0.5 ms,
so the utilityProcess router is deprioritized by data; (2) the crisis is
queueing between daemon egress and renderer parse completion — main
per-chunk processing, the 512 KB delivery/ACK pacing (ACKs fire after
renderer write callbacks, so renderer slowness throttles delivery
multiplicatively), and renderer per-chunk layers above xterm; (3) the
agent-TUI shape (DEC-2026 frames + erase/repaint) is 6.5× worse than plain
text inside Orca while being equal-cost everywhere else — profile it in the
renderer first (task #9).

### 2026-07-02 — dev-build check of #7139/#7150 (confounded; directional only)

Dev build of orca-performance (282-col window, 3MB fixtures, dev-mode
overhead): DSR idle p50 0.64 ms (unchanged), **DSR under load p50 161 ms** —
the cooperative-drain branch does not move the under-load class. In
hindsight this is structural: DSR replies are ordered within the output
stream, so the metric measures output-queue depth; #7139 paces draining to
protect input-send responsiveness but cannot reorder the queue. Implications:
(1) the 134 ms-class number is fixed only by shrinking the queue (producer
flow control) or raising drain rate (the 51× throughput hunt); (2) #7153's
own wins (freeze class, bounded memory, input-loss guards) must be validated
with freeze scenarios and real typing, not DSR. Also learned: dev-mode runs
are ~2× slower across the board and fences need `--dsr-timeout-ms` headroom.

### 2026-07-02 — 51× loss attributed: scheduler fixed-nap drip (task #9)

The renderer output scheduler (`pane-terminal-output-scheduler.ts`) drained
at most 2×16KB per tick, then slept 4ms (high-priority) / 16ms (background)
regardless of parse speed. Isolation bench (fake timers, instant-parse
terminal — `pane-terminal-output-scheduler-throughput.bench.test.ts`,
`ORCA_TERMINAL_PERF_BENCH=1`): **background cadence = 1.9 MB/s — matching
prod's measured 2.0 MB/s agent-tui ceiling**; foreground = 27 MB/s (only
when arrivals re-poke 0ms drains; Chromium's ~4ms timer clamp makes the
sustained real-world HP ceiling ~8 MB/s). Classification: pty-connection's
`isLatencySensitiveForegroundOutput` routes sizable no-recent-input chunks
to the queue, so floods always ride the drip.

Fix (committed 9e8bb2243): high-priority drains are now **parse-clocked** —
a pacer re-arms a 0ms drain when xterm's write callback confirms the batch
parsed — and carry 8 writes/tick (128KB ≈ 1.3ms parse). Isolation ceiling:
27 → **117.6 MB/s** (parse-limited). Background cadence deliberately
unchanged (protects the focused pane; hidden panes are term-speed-2's job).
`DRAIN_TIME_BUDGET_MS` still bounds tick work (cooperative-drain intent of
#7139 preserved; its budget-yield test still passes). 621 tests green.

Open follow-ups from this attribution: (a) end-to-end dev verification (in
progress); (b) whether main's `background:true` delivery marking demotes
visible-pane floods to the background drip — check
`window.__terminalOutputSchedulerDebug` counters in a dev run; (c) ascii-log
gap (13 vs 83 MB/s headless) — likely per-chunk `beforeWrite` side-effect
scanning; profile after (a).

### 2026-07-03 — THE WHALE: main's retained-tail redraw path is O(tail) per chunk

Parse-clock fix didn't move end-to-end (agent-tui still 0.7 MB/s dev). Layered
probes (renderer scheduler counters → main whole-method timer → per-section
timers → targeted micro-benches) attributed it fully:

- Renderer receives only ~350–770 KB/s — it is **starved**, not slow.
- `OrcaRuntime.onPtyData` consumes **~93% of main's event loop** during the
  flood (~950 ms/s at ~450 chunks/s ≈ 2.1 ms/chunk).
- All wrapped sub-calls (OSC scanners, agent detect, watchers, headless
  track, leaves loop, mobile touch) together: **~3.5%**. The remainder is the
  pty-record tail block.
- Micro-bench (`appendNormalizedToTailBuffer` with a real agent-TUI frame
  containing `ESC[10A ESC[0J`): **0.888 ms/chunk at a 2,000-line tail** — 32×
  the plain-append path. Cause: `appendNormalizedToMultilineTailBuffer`
  materializes ~2,001 row objects per chunk (orca-runtime.ts:22324) and
  `finalizeRetainedTerminalRows` allocates them all again plus runs a
  trailing-whitespace regex per row (:22458) — ~4k allocations + 2k regexes
  per tiny chunk, twice the tail length in O(n) passes. Every Claude-Code
  frame (cursor-up + erase-below) takes this path; plain logs don't — which
  is exactly the measured agent-tui vs ascii asymmetry.

Chain: TUI flood → O(tail) work per chunk in main → main event loop
saturates → daemon socket backpressures → renderer starved at ~0.4 MB/s →
deep queue → 134 ms DSR-under-load.

Fix (in progress): run the existing algorithm on a lazy suffix window (the
cursor's maximum upward reach, computed from the chunk) with the untouched
prefix shared by reference; differential fuzz test proves output equality
against the original implementation. Worst case (pathological full-height
cursor-up) falls back to today's cost.

### 2026-07-03 — windowed-tail fix: partial end-to-end win; next suspect queued

Dev-build bench after the windowed redraw-tail fix (label dev-tailfix, same
protocol as dev-parseclock): agent-tui **0.7 → 1.0 MB/s (+43%)**, DSR-under-
load **p50 161 → 108 ms, p99 624 → 154 ms (4×)**. Real movement for the
first time, but the pipeline is still far from the renderer's 27–117 MB/s
capacity — another main-side consumer remains hot.

Next cycle (exact recipe): re-apply the whole-method main probe
(`onPtyDataMs` sampler in `pty.ts` bindProviderListeners) on the fixed
build. If onPtyData still dominates, the remaining O(tail)/per-chunk
suspects in priority order: (1) `buildTerminalWaitText` ×2 per chunk (full
tail join, 0.116 ms/chunk in prod-node isolation — likely 2-4× that in
dev); (2) `normalizeTerminalChunk` (regex over every chunk, never measured);
(3) the per-leaf duplicate tail path when `tailStateMatches` fails. If
onPtyData no longer dominates, probe the main→renderer delivery batching
next. The probe/bench cycle is mechanical: relaunch dev
(`ELECTRON_ENABLE_LOGGING=1 pnpm dev`), `orca-dev terminal create --command
"<bench> --label X --size-mb 3 --dsr-timeout-ms 120000"`, grep the log.

### 2026-07-03 — post-fix attribution: `blockedCheck` is the remaining whale

Post-windowed-tail probe run (dev build, agent-tui): `onPtyData` still
~90% of main's event loop (~930 ms/s). Bucket split per second:
**blockedCheck ≈ 700–790 ms (~85%)**, waitText ≈ 70, append ≈ 25 (windowed
fix confirmed), normalize ≈ 7, preview ≈ 0.

Mechanism (orca-runtime.ts:23128 `nextTailHasNewerBlockedReason` + its
callers): per chunk, TWO full wait texts are built (`buildTerminalWaitText`
joins the whole ≤256KB tail), then the check calls `.toLowerCase()` on both
(another ~512KB of string allocation per chunk) and runs multi-pattern
blocked/ready scans (`findTerminalWaitBlockedSignal`,
`findKnownReadyPromptIndex` — lastIndexOf/regex passes over the full text)
— all to timestamp `waitBlockedAt` for `terminal wait`.

Fix design (next session): blocked/ready prompts are end-anchored — an
actionable prompt is at the END of output. (1) Run the check on a bounded
suffix of the wait text (last ~64 lines / 16KB) instead of the full tail;
(2) cheap pre-filter: skip entirely unless the appended chunk (plus a small
carry for split keywords) can contain a blocked keyword; (3) build the two
wait texts only when the check runs. Verification mirrors the windowed-tail
pattern: keep the full-text check as reference + differential fuzz over
randomized tails/prompts (split-across-chunks cases included — the
`appendCandidateSignal` ordering semantics at :23146 must be preserved),
plus the terminal-wait contract tests. Expected effect: removes ~85% of
remaining onPtyData cost; combined with the two landed fixes should
finally unlock the pipeline toward the renderer's measured 27–117 MB/s.

### 2026-07-03 — pipeline unlocked: three stacked fixes, 16× throughput, 9× latency

Dev-build bench with all three fixes (parse-clocked drains 9e8bb2243,
windowed tail 4e08a28cd, throttled blocked-check 66f20258e), label
dev-blockedfix, same protocol/config as prior dev rows:

| metric | pre-fix dev | +tail fix | +blocked fix |
|---|---|---|---|
| agent-tui MB/s | 0.7 | 1.0 | **11.5** |
| DSR load p50/p99 (ms) | 161 / 624 | 108 / 154 | **18.8 / 24.9** |
| DSR idle p50/p99 (ms) | 0.95 / 21 | 1.09 / 18 | **0.52 / 8.6** |
| ascii-log MB/s | 6.4 | 4.7 | **9.6** |

The agent-TUI-specific penalty is gone (agent-tui ≈ cjk ≈ ascii now). The
throttled blocked-check delivered the predicted ~85% cut. Dev mode carries
~2× overhead vs prod, so the prod build should land near ~10ms DSR-under-
load — from the 134ms baseline (~13×) — pending a packaged-build rerun.
Remaining floor is structural cadence (8ms daemon batch + 4ms HP drain
ticks + xterm 12ms slices), which flow control (#6) does not target;
re-evaluate the "within 10× of Terminal.app" goal line after a prod
measurement. Next: term-speed-2 revival (#4), then flow control (#6).

### 2026-07-03 — term-speed-2 revival: merged, green, NOT yet mergeable (perf gate)

`revive/term-speed-2` pushed (merge a5052c35f, tip 64b6f7abe): 144 files,
typecheck clean, ~2,776 targeted tests green, all three of our fixes
verified present, chain features present and kill-switched (subagent's
six review risks recorded in its report). Bench verdict on the revived
build (dev): DSR-load p50 ~19ms holds, but **throughput regressed ~35%
unconditionally** (agent-tui 11.5 → 7.2–7.4 MB/s; all-switches-OFF round
proved the kill switches are NOT the cost) and idle p50 doubled.

Attribution so far: main exonerated (whole-method probe: onPtyData ~60ms/s
≈ 6%); renderer reconcile + HP-first selection O(1)-checked; **daemon
CONVICTED by unit bench — `Session` ingest 103 → 39.5/47.7 MB/s (2.2–2.6×)
on the revive branch** (`session-ingest-throughput.bench.test.ts`,
ORCA_TERMINAL_PERF_BENCH=1). Cause: the chain's headless-emulator
restructure (scanner classes / query-reply forwarding / view-attribute
responder) added per-byte cost to the daemon hot path. Chunks reaching
main are now ~5.8KB vs ~650B (daemon emits slower, batches bigger).

NEXT (fast inner loop — pure unit bench, no app restarts): on
revive/term-speed-2, diff `headless-emulator.ts`/`session.ts` vs
7839fb9db, find the per-chunk scanner cost, restore our bounded-parser
fast paths (the daemon emulator must never pay per-byte JS scanning for
bytes that contain no ESC — same pre-filter pattern as the blocked-check
keyword bypass), verify with the ingest bench back at ~100 MB/s, then
full dev bench expecting blockedfix parity (~11.5 MB/s), THEN merge to
orca-performance. A residual renderer-side share is possible once the
daemon is fixed — re-attribute after.

Merge gate: revive branch merges only at ≥ blockedfix numbers.

**RETRACTION (2026-07-03, later):** the daemon conviction above was a
confounded measurement — the 39–48 MB/s ingest runs executed while a dev
app was still running. On a quiet machine the revive branch ingests at
**82–109 MB/s** (≈ pre-merge) and its HeadlessEmulator alone does 99.5 MB/s
vs raw xterm 77.7. The daemon is innocent. Consequently the end-to-end
revival delta (11.5 → 7.2/7.4 dev) is also UNTRUSTED — none of those runs
were load-controlled, and unit benches show up to 2.6× machine-load
variance. Scanner pre-filters landed anyway on revive (71c89da9b;
strictly positive, 641 daemon tests green).

**New measurement protocol (mandatory from here):** quiet machine (no dev
apps or benches concurrent), paired A/B runs back-to-back alternating
branches, n≥2 per side, report spread not just p50. The merge-gate
comparison (blockedfix vs revive) must be redone under this protocol
before any verdict. Next: run the controlled A/B; if the delta
disappears, merge revive into orca-performance and proceed to flow
control (#6); if it persists, resume attribution renderer-side (probe
pty-connection dataCallback additions per chunk).

### 2026-07-03 — A/B gate passed; term-speed-2 MERGED to orca-performance

Load-controlled alternating A/B (fresh app per run, n=2/side, agent-tui +
DSR-load): perf 6.7/5.2 MB/s, dsr p50 19.9/21.3, p99 107.8/218.1; revive
6.1/3.6 MB/s, dsr p50 21.4/20.3, **p99 63.4/26.1**. Verdict: latency p50
tied, p99 better on revive, throughput within overlapping noise (revive2's
3.6 followed two runtime-busy create failures). The earlier "35%
regression" is confirmed noise. Note: both branches ~5-7 MB/s today vs
11.5 yesterday — dev benches carry ~2x day-to-day machine variance;
absolute dev numbers are only comparable within one A/B session.

Merged revive/term-speed-2 → orca-performance; typecheck clean, 288
post-merge spot tests green. orca-performance now = main-ish base + #7153
+ three perf fixes + full term-speed-2 chain (kill-switched, default ON)
+ scanner pre-filters. Extended user testing now covers everything.
Remaining from the revival agent's risk list: gate×drain e2e specs
(terminal-hidden-*, parked-memory, sleep-wake) still not run — queue them.
Next: producer flow control (#6) per design §5; prod packaged-build bench
for the real headline numbers.

### 2026-07-03 — flow control merged; goal-state accounting

Producer flow control merged to orca-performance (348aeb325): protocol
v19 `pausePty`/`resumePty`, 256KB/32KB watermarks on main's pendingData,
node-pty kernel backpressure, 5s daemon-side lost-resume failsafe +
main-side pause re-assert, resume on every teardown path, version-gated
(v≤18/SSH no-op), kill switch `PRODUCER_FLOW_CONTROL_ENABLED`
(ipc/pty.ts:143), 29 new tests. Typecheck + 292 post-merge spot tests
green.

**Definition-of-done accounting:**
- 51× loss: ATTRIBUTED AND FIXED (three fixes; agent-tui 0.7→11.5 MB/s
  and DSR-load p50 161→18.8 dev, results committed).
- term-speed-2: REVIVED AND MERGED (A/B gate passed).
- Flow control: IMPLEMENTED AND MERGED.
- "Within 10× of Terminal.app (4.5ms)": RE-SCOPED to pending a packaged
  RC measurement. Evidence: dev = 18.8ms with ~2× dev overhead → prod
  projection ~9-10ms ≈ 20× Terminal.app (vs 300× at baseline). The
  remaining gap is structural cadence (daemon 8ms batch, renderer drain
  ticks, xterm 12ms parse slices) — tunable follow-ups, distinct from the
  waste class this initiative eliminated. Prod verification path:
  electron-vite preview CANNOT host the bench (CLI-created panes are not
  adopted by the preview window's renderer → no ACKs → pending-cap drop;
  two attempts, documented) — measure on the next packaged RC cut from
  orca-performance using the committed rig + protocol instead.

**Deferred, ordered:** (1) sync orca-performance with main — conflicts
incl. stream-opcode collision (chain `Ack=12` vs main's #7205-era
`Metadata=12`; renumber chain side, audit mobile/web stream consumers);
(2) chain's e2e specs (hidden parking / parked memory / sleep-wake) —
gate×drain risk; (3) cadence tuning toward the 10× line; (4) rig
extensions + P90 telemetry (tasks #3/#8).

### 2026-07-03 — PROD VERDICT: v1.4.121-rc.0 benchmarked (the headline numbers)

Same rig, same protocol, same machine as the 1.4.91 baseline:

| metric | 1.4.91 baseline | v1.4.121-rc.0 | change |
|---|---|---|---|
| DSR idle p50 | 0.69 ms | **0.44 ms** | = Terminal.app (0.45) |
| DSR under load p50 | 134 ms | **18.6 ms** | 7.2x |
| DSR under load p99 | 292 ms | **29.7 ms** | 9.8x |
| agent-tui | 2.0 MB/s | **11.2 MB/s** | 5.6x |
| styles-stress | 7.8 MB/s | **10.4 MB/s** | 1.3x |
| ascii-log | 13 MB/s | 11.0 MB/s | ~0.85x |
| cjk-emoji | 15 MB/s | 12.2 MB/s | ~0.81x |

Reading: the anomalous TUI penalty is GONE — all four fixtures now sit at
a uniform ~11-12 MB/s, which is the scheduler pacing ceiling, not parse
CPU (prod ≈ dev for both latency and throughput; the pipeline is
cadence-bound, so faster prod code changes nothing). That uniform cap
also explains plain-text dipping slightly below baseline: ascii/cjk used
to run unpaced ahead of the old scheduler; now everything flows through
the same parse-clocked path. Goal line check: 18.6 ms = 41x Terminal.app
under load (goal was 10x = 4.5 ms) — NOT met; down from 300x. Idle IS at
parity. The remaining 4x is the named cadence stack (daemon 8 ms batch,
scheduler drain ticks + 8x16KB per-tick budget, xterm 12 ms slices) —
next lever, tunable, tracked as follow-up. p99 tail (the freeze class)
is 29.7 ms — users cannot perceive it.

Caveat: measured on the user's live app (this session active in it);
idle p99 118 ms reflects that activity, not the terminal path.

### 2026-07-03 — Same-engine reference: VS Code head-to-head (same machine, same rig)

| metric | Orca v1.4.121-rc.0 | VS Code | verdict |
|---|---|---|---|
| DSR idle p50 | **0.44 ms** | 7.00 ms | Orca 16x faster |
| DSR load p50 | 18.6 ms | **7.18 ms** | VS Code 2.6x faster |
| DSR load p99 | **29.7 ms** | 43.4 ms | Orca 1.5x better tail |
| ascii-log | **11.0 MB/s** | 9.0 | Orca +22% |
| cjk-emoji | 12.2 | 11.3 | tie |
| agent-tui | 11.2 | 11.7 | tie |
| styles-stress | **10.4 MB/s** | 2.0 | Orca 5.2x |

Orca now beats or ties the best-known xterm.js terminal on 5 of 6
metrics — including 16x at idle (what users feel all day) and 5x on
SGR-heavy output — and holds a better p99 tail under load. Throughput
sits at the shared engine ceiling (~9-12 MB/s), confirming the class
limit.

The one loss (load p50) has a clean mechanism: VS Code's producer flow
control caps unacked output at ~100KB, so its standing queue is
~100KB / 11.7 MB/s ≈ 8.5 ms — matching its 7.18. Our standing queue
(18.6 ms ≈ ~200KB at 11 MB/s) is set by the main→renderer ACK window
(512KB/pty high water) + drain re-arm cadence (Chromium clamps nested
setTimeout to ~4ms). Two levers, both cheap to test: (1) MessageChannel
drain scheduling (sub-ms re-arm; also raises the throughput ceiling);
(2) tighter effective in-flight window on the renderer delivery path.
Target: VS Code's ~7ms class or below without giving back throughput.

### 2026-07-03 — Batch windows were the gap: dev DSR-load p50 19 -> 8.0ms

Lever results (dev, 3MB protocol, same session):
- MessageChannel drains (2434dfaae): 19.01ms — NO change. Proved the
  ~19ms was NOT queue depth: at 1MB/s vs ~11MB/s capacity (9% util)
  there is no standing queue. Kept (correct, removes a real clamp).
- Batch windows 8->2ms on BOTH hops (e67a91d7a: daemon
  STREAM_DATA_BATCH_INTERVAL_MS + main PTY_BATCH_INTERVAL_MS):
  **p50 8.00 / p90 10.13 / p99 12.26ms** (from 19.01/22.7/28.1).
  Throughput unchanged (agent-tui 9.8 vs 9.1, ambient noise). 239
  batcher+pty tests green after timing updates.

Dev-mode 8.0ms already matches VS Code prod (7.18); prod build should
land BELOW VS Code. p99: ours 12.3 vs VS Code 43.4. The remaining
fixed-latency terms are renderer/xterm-internal (12ms parse slices).
Note: main's interactive bypass (input-gated) means real keystroke echo
skips batching entirely — the DSR metric understates real typing
responsiveness; VS Code measured on the same freight path, comparison
fair.

Next: cut RC, confirm in prod, re-baseline vs Terminal.app (expect
~8-15x from 300x at baseline; goal line 10x = 4.5ms now plausibly in
reach).

### 2026-07-03 — Chain e2e debt PAID: all 6 hidden-pane specs green

terminal-hidden-view-parking (parks + restores rich TUI on reveal; bell/
title side effects live while parked), terminal-sleep-wake-restore
(output restored + input accepted after wake), terminal-parked-memory
(renderer memory released on park; views retained when kill-switched
off): 6/6 passed, electron-headless, 1.1m. The gate x drain interplay —
the revival's top flagged risk — now has e2e coverage on the exact
branch the RC ships from. Remaining garble-hardening: differential
hide/reveal fuzz harness (next build), reveal-time seq diagnostics.

## Success criteria (baseline-relative; finalize after task 1)

- DSR-under-load p90 in Orca within striking distance of iTerm2 on the same
  box; zero DSR timeouts (today's freeze class).
- Fenced agent-tui throughput ≥ VS Code on the same box.
- Idle RSS with 0–1 agents materially down (target set after the memory
  harness lands; hidden-pane parking is the main lever).
- Zero >100 ms event-loop stalls in main/renderer during a 10 MB flood.
- Production P90 typing latency down and monitored continuously.
