# Orca live lag investigation — September 5, 2026

## Consolidated performance issue register — compiled 2026-09-11

Every performance issue found across the four `debug-orca-performance` sessions,
the `debug-orca-perf-issue` sessions (worktree since deleted, branch survives as
`origin/debug-orca-perf-issue`), and the `improve-cmd-j-dialog-performance`
session. Each row keeps the measurement it came from. Status is what the
evidence supports today, not what is hoped for.

Companion documents in this worktree:
`orca-persistence-design-assessment.md` (implementation spec for P1–P8),
`docs/reference/typing-latency-field-diagnosis-2026-09-10.md` (H1–H5, R1–R8),
`docs/reference/renderer-agent-status-performance.md`,
`docs/reference/spinner-rendering-performance.md`.

### Summary

| Group | Issues | Fixed | Open |
| --- | ---: | ---: | ---: |
| Persistence / main-thread state writes (P) | 11 | 4 | 7 |
| Host and machine contention (H) | 5 | 0 (operational) | 5 |
| Main process: git and subprocess load (G) | 8 | 0 | 8 |
| Renderer and terminal rendering (R) | 8 | 0 | 8 |
| Terminal daemon session leak (D) | 9 | 1 | 8 |
| Cmd-J palette search (C) | 6 | 0 (spec only) | 6 |

### P — Persistence and main-thread state writes

Source: `debug-orca-performance` sessions `3dc15f5c`, `411b72f9`, `484eb712`.
Live probe on the packaged app, PID 67676, build `1.4.198-adhoc.20260907185057`,
9.0 MB profile under `profiles/local-default/`.

| # | Issue | Measured | Status |
| --- | --- | --- | --- |
| P1 | Terminal reattach clones the whole workspace session and forces a whole-app synchronous flush even when the binding already matches | 4 calls in 30 s, 59.15–99.80 ms each; flush 48.37–84.38 ms; overlapping renderer→main IPC 142.6–232.9 ms | **Fixed** — fast lane in `pty-binding-fast-lane.ts`, early return in `pty-binding-persistence.ts` |
| P2 | `writeToDiskSync` returns on a hash match without raising `lastDurableWriteGeneration`, while `flushOrThrow` has already bumped `writeGeneration` | Counter parks one generation behind after every no-op flush; the fast path would silently disable itself after its first fall-through | **Fixed** — `primary-state-writes.ts` raises the counter on the unforced hash-match return |
| P3 | The unchanged-state hash comparison runs *after* `buildStateToSave()`, so a skipped disk write still pays full serialization, encoding and hashing on main | 12 `buildStateToSave` calls in 30 s, 34.88–43.94 ms each, 468.20 ms of synchronous serialization in the window; ~9.23 MB per call | Open — deferred fix 3 |
| P4 | State document bloat: one terminal attach serializes megabytes of unrelated history | 9,372,404 bytes total: `workspaceSession` 4,486,512; `automationRuns` 3,380,645 (661 entries); `worktreeMeta` 637,426 | Open |
| P5 | Split tabs ping-pong the tab row's PTY id: a tab row holds one `ptyId` while a tab holds several panes, and main overwrote it with whichever pane bound, contradicting the renderer's stated rule | Real profile: 1,424 tabs, 1,764 panes, 310 split tabs, 674 panes (38%) that could never reach the fast lane | **Fixed** — `terminal-tab-pty-ownership.ts`, shared by the write path and the predicate |
| P6 | The durability check compared two *global* counters, so any unrelated dirty state held the fast lane shut | 9 of 17 reattaches missed on `not_durable` alone, 209 ms of the 337 ms spent flushing in that window (62%) | **Fixed** — per-pane durability records in `pty-binding-durability-records.ts` |
| P7 | A reattach that cannot find its tab mints a duplicate tab and layout instead | 16 reattaches in one minute all missed on `tab_missing, layout_missing`; 16 new tabs titled "Terminal 1" in one worktree. Dev profile 116 tabs, real profile 1,424 — the likely source of the 9 MB document | **Open, not chased** — highest-leverage remaining lead |
| P8 | The debounced autosave serializes the same ~9 MB on main roughly once a second while state is changing | Same 34.88–43.94 ms per serialization as P3 | Open — deferred fix 3, autosave-only scope |
| P9 | Deferred fix 2 (small binding transactions) is blocked on four consumers of the single state document | Backup rotation, the orcad snapshot member set, profile transfer, and older builds that read the file directly | Deferred |
| P10 | The binding-writer ratchet cannot see aliased writers: `ssh/ssh-target-id-migration.ts` rewrites `tab.ptyId` and `ptyIdsByLeafId` in place through a parameter named `record` | No correctness hole today — it bumps the generation through its caller's `scheduleSave` — but the regex is a tripwire, not a proof | Open by design; recorded in the writer table |
| P11 | Five paths mutate durable state in place without bumping `writeGeneration` (`ssh-pty-binding-cleanup`, `ssh-pty-lease-operations`, `ssh-pty-lease-tombstone-retention`, `workspace-session-snapshot-publication`, `loaded-state-adaptation`) | Reviewed and cleared for *this* fix: none sets a binding to a requested value, and the equality check catches a cleared binding. An earlier claim that all five had to be fixed first was withdrawn | Open, low severity |

Fix-3 constraint worth keeping: secret encryption needs Electron `safeStorage`
on main, the worktree-meta projection depends on reference identity a worker
boundary destroys, and `flushOrThrow` is a synchronous barrier a worker cannot
provide. Fix 3 is scoped to the debounced autosave only.

### H — Host and machine contention

Source: `debug-orca-performance` session `3a100df6`, 2026-09-10, packaged
`1.4.200-adhoc`, main PID 87050 / renderer 87163, 18-core Apple Silicon, 128 GB.

| # | Issue | Measured | Status |
| --- | --- | --- | --- |
| H1 | Host fully saturated — this was the primary cause of the reported lag at that moment | CPU idle 0.27%, load 28–54; 124 of 128 GB RAM used with 66 GB in the compressor; swap 47.0 of 48 GB compressing at 32 MB/s; 2,345 processes | Operational |
| H2 | Activity Monitor (PID 67969) leaked to a 99 GB footprint, all dirty malloc, after 7 days, burning 82–101% CPU | Killing it: swap 47.0→16 GB, RAM used 124→95 GB, free 3→31 GB, CPU idle 0.3%→20% | Resolved by SIGKILL |
| H3 | A Codex-spawned `rg --hidden` scanning the whole home directory | PID 65656, 130–340% CPU for over 3 minutes, ~16k IOPS | Operational |
| H4 | 179 agent CLI processes (93 codex, 65 claude, 11 agy, 10 opencode) plus four dev Orca instances, one renderer at 2.6 GB | 27 GB RSS, ~200% CPU combined | Operational |
| H5 | Earlier (2026-09-05/07) skill-discovery scan storm from release agents over the home directory | `rg` at 314%, 351% and 390% CPU; 18 CPUs, 3,075 processes, 33,750 threads, 73.86% system, 4.92% idle, load 17.13. Remediation is targeted skill-directory discovery and dedup across release workers | Open (agent-side) |

Keystroke path context: every keystroke crosses six process hops (renderer,
main, daemon, shell, back, GPU, WindowServer). Under H1 each hop competes with a
runqueue of 30–50 threads, and any compressed page it touches must be
decompressed first. Ghostty is one native process, which is why it stayed fast.

### G — Main process: git and subprocess load

| # | Issue | Measured | Status |
| --- | --- | --- | --- |
| G1 | Git subprocess storm on the main process event loop | 822 `git.exec` spans in 10 minutes, 97 s of git wall time, 407–614 spawns per 5 minutes for an hour; admission queue wait p95 25 ms, max 568 ms | Open |
| G2 | The `orca` repo itself is pathological, making every spawn slow | 630 registered worktrees, 9,266 refs, 394 pack files plus 10 abandoned `tmp_pack_*`, 266,787 loose objects (6.3 GB); `git worktree list` 1.78 s, `git status --porcelain` 0.64 s (1.5 s sys) | Operational — `git worktree prune`, `git gc` |
| G3 | `git worktree list` re-run instead of cached | 59 calls / 20 s in one 10-minute window, ~40 calls in 10 minutes at 1.78 s each | Open — follow-up 5 |
| G4 | node-pty and `pty:write` live in the main process (`src/main/ipc/pty/ipc/write.ts:23`); every git/gh spawn is initiated synchronously on that same loop (`src/shared/child-process/run-process.ts:51`); git stdout is decoded and parsed in the main-thread data handler (`src/main/git/command-runner/git-stream-stdout.ts:184`). Admission caps limit concurrency, not spawn count (`git-admission-state.ts:4`) | Main-process main thread measured 25% busy, mostly `OnUvRead` of child stdout and PTY socket data | Open — architectural |
| G5 | gh PR fanout: two `gh` processes per refresh (branch lookup then `gh pr view`), triggered per visible worktree row and by a 60 s per-card timer | Serialized and budgeted, so a lesser factor | Open — follow-up 6 |
| G6 | `could not lock config file ~/.gitconfig` — concurrent agents racing on global git config | Observed in a terminal during the capture | Open |
| G7 | Earlier `git show-ref` fan-out: `getPullRequestRemoteRefState` → `listExactRemoteBaseRefs` (`pull-request-remote-ref-probes.ts`) → `probeExactRefs` (`git/exact-ref-probe.ts`) builds a candidate per configured remote, concurrency eight | Bursts of 18 `show-ref` calls, 17 failing, 20–31 ms each; 550 calls in 10 minutes; 191 in a 3-minute window | Open |
| G8 | Synchronous `uv_fs_access` on the main thread from a timer callback (2026-09-05, PID 99632) | 3,033 of 8,321 main-thread samples (36.45%); renderer 90.21% idle in the same window. JS caller and pathname never identified | Open, unreproduced since |

### R — Renderer and terminal rendering

| # | Issue | Measured | Status |
| --- | --- | --- | --- |
| R1 | Main parses every PTY chunk for agent status and titles and sends a `pty:sideEffect` IPC message to the renderer per chunk (`src/main/runtime/orca-runtime-on-pty-data.ts:36`). Titles are damped to one per 500 ms; agent status and bells are not | 200 live terminals feeding the renderer regardless of visibility; five agent TUIs redrawing heavily, one opencode at 86% CPU | Open — follow-up 1 |
| R2 | The agent status reducer builds a new object per update (`agent-status-live-reducer.ts:87`), so every status ping re-runs every Zustand selector in the app | Renderer main thread 28% average, bursts to 32%, one 5 s sample 86% busy; time spent in JIT-compiled JS and IPC deserialization, not GC or rendering | Open — follow-up 2 |
| R3 | 27–33 terminal pane managers mounted while one is visible; park-verdict churn pins tabs mounted for 60 s at a time (`terminal-park-verdict-flip-telemetry.ts:144`, issue #15136) | Mounted panes keep xterm buffers and per-pane 3 s pollers, and share one 8 ms drain budget with the visible pane | Open — follow-up 3 |
| R4 | The hidden-pane output gate is per tab, so a hidden pane inside the visible tab's split still gets every byte written into xterm (`terminal-pane-pty-deps.ts:55`) | — | Open — follow-up 4 |
| R5 | Every tab reveal clears the WebGL glyph atlas for all visible terminals and forces a repaint (`pane-reveal-repaint.ts:63`) | 88 times in the current log | Open — follow-up 7 |
| R6 | Keystroke echo through a live Orca terminal | 180–460 ms, bounded rather than measured (the CLI read itself costs ~330 ms) | Open |
| R7 | Renderer resource accumulation across a day: heap and private memory climb, then fall back after a restart | 197→347 MB JS heap and 772–1,517 MB private memory before a restart versus 71–144 MB and 207–221 MB after; 11,330 DOM nodes, 1,119 stored terminal layouts, ~26 MB serialized store; later census 727 worktrees, 1,111 terminal tabs / 1,630 unified tabs, ~4,900–5,000 store listeners, 178 stored agent rows | Open |
| R8 | Terminal replay wedges: `terminal_replay_guard_wedged_release` breadcrumbs, plus an unhandled "no diff result available" rejection and a `terminal_park_verdict_churn` burst | Six breadcrumbs across two panes (three events per pane, not six failures); replay-guard waits 10 s to probe and another quiet 10 s before declaring a wedge | Open, never correlated with a keystroke |

Measurement caveat carried forward: the 98.8 ms median / 520.2 ms maximum
"parse → render" figure from the 2026-09-07 echo diagnostic is **not** valid as
paint latency. xterm invokes the write callback before firing `onWriteParsed`,
and Orca's foreground write callback can synchronously refresh the terminal, so
the diagnostic attributes the *next* content render to the input. Do not use it
to justify changing xterm scheduling, synchronized output, or GPU settings.

### D — Terminal daemon session leak

Source: `debug-orca-perf-issue` session `9565dd27` (worktree deleted; branch
`origin/debug-orca-perf-issue`). Documented there in
`docs/terminal-daemon-session-leak-investigation.md`.

| # | Issue | Measured | Status |
| --- | --- | --- | --- |
| D1 | The terminal daemon held ~427 live login shells with ~1,900 descendant processes, and the main process pinned at 100% CPU draining their PTY output | Daemon PID 22100, 5 days old, survived the app restart; a 3-second `sample` showed the main thread almost entirely inside Node stream-read callbacks | Resolved operationally by a later restart (427→73 shells, 100%→0.6% CPU); underlying leak open |
| D2 | Sessions leak because kills fail silently | 1,745 sessions created versus 927 exited; 151 `session-kill-failed`, 108 `shell-ready-timeout`. Per-day since Aug 14: 60–200 leaked/day, 3–126 kill failures/day, no step change | Open |
| D3 | The kill path swallowed the error, so the log said a kill failed but never why (`daemon-request-router.ts:197-201`) | Payload carried only `{sessionId, immediate, clientId}` | **Fixed** — the payload now carries `errorName` and `error`; test in `daemon-server-kill-attribution.test.ts` |
| D4 | Rejected hypothesis: `shell-ready-timeout` caused by the Aug 18 content-addressed wrapper change (#15285) | Overlap is 138 of 1,054 timeout sessions (13%); 1,145 leaked sessions never timed out; the Aug 20 onset is an artifact of that commit *adding the log line*; a 300 ms barrier timeout only releases held bytes and never alters the process tree | Not the cause |
| D5 | The real leak shape is `created → killed → kill-failed` with no attach and no exit; the daemon reports the session killed, a later kill fails, and the shell is never seen exiting | Most common sequence in the log. Prime suspect is `SessionNotFoundError` from `getAliveSession`: the session is gone from the map while the shell still runs | Open — D3 is what makes the next occurrence self-diagnosing |
| D6 | Stale-daemon adoption: the daemon protocol has not moved past v36, so new app versions keep adopting an old daemon and daemon-side fixes never land | Daemon from `1.4.191` (Aug 28) still serving app `1.4.197`, later `1.4.200` — 9 then 13 days old | Open — design question: replace the daemon on app-version change, not just protocol change |
| D7 | No session-count backstop or age-based reap, so a silently failing kill path degrades into hundreds of live shells | — | Open |
| D8 | Sidebar flashing is the same chokepoint: per-session status churn drives sidebar re-renders | One tab flipping park state 12 times in 42 s; 29 recent `sidebar_worktree_activate`; renderer heap swinging 200–480 MB per minute | Open (same root as R3) |
| D9 | Secondary burst: the readiness-checklist automation ran `xargs -P 64` calling `orca orchestration worker-release` | 3,481 dispatches; it ended without CPU dropping, so it was not the root cause | Operational |

### C — Cmd-J palette search

Source: `improve-cmd-j-dialog-performance` session `90ab767d`, verified against
`a899f92402`. Spec: `docs/reference/cmd-j-search-performance-design.md` in that
worktree. No code changed.

| # | Issue | Measured | Status |
| --- | --- | --- | --- |
| C1 | Document representation is the real memory cost: `atoms`, `words` and `components` are one object per token, each holding a sliced string, so retention is ~7× the text-plus-offset estimate | 204 MiB for an 800-document long-comment fixture. Fix is packed `Int32Array` boundary tables, not eviction | Spec |
| C2 | The `documentPayloadMb` budget in `palette-match-budget.ts` undercounts retention by that same ~7× factor | Should be replaced with a retained-heap probe | Spec |
| C3 | The draft's 32 MiB cache budget holds ~130 of 800 documents, so the motivating fixture re-normalizes ~85% of its corpus on every new query | — | Spec — budget rejected |
| C4 | The most frequent live invalidation was missed: `worktree-unread-activity.ts` bumps `lastActivityAt` on terminal output, replacing one `Worktree`, which replaces `allWorktrees`, which rebuilds all 800 documents while the palette is open | — | Spec — reuse rule now handles it |
| C5 | `workspace-kanban-search.ts` calls `buildWorktreePaletteDocuments` with `evidencePolicy: 'board'`, so a shared cache must key on policy or the palette and the board thrash each other | — | Spec |
| C6 | Text match and ranking cannot be memoized apart today: `toWorktreePaletteSearchResult` and `baseResult` fold `preparePaletteActivity` into the match result, so a `nowMs` change forces a re-match | Steady-state work after a per-entity cache is O(changed entities) plus 30–50 ms of matching, which is why a worker was demoted to a gated option | Spec |

Rollout note from the same review: CDP paint timings quantize to frame
boundaries, so a 2 ms tolerance would block rollout on artifacts. Function-level
timings keep the tight bound; paint-level timings get one frame.

### What the fast-lane work actually bought

Measured on the dev instance trace (`persistence.pty-binding` spans) and against
the real profile. Full numbers are in the PR body.

| Stage | Reattaches | Fast lane | Flushed | Main-thread ms |
| --- | ---: | ---: | ---: | ---: |
| Before any fix (22 calls) | 4 | 0 | 22 | 710 ms, 13–84 ms per call |
| After tab-row fix (17 calls) | 13 | 2 (0 ms total) | 15 | 337 ms, of which 209 ms was `not_durable` alone |
| After per-pane durability | — | expected to absorb that 209 ms | — | — |

`Reattaches` counts a subset of all calls by origin; it overlaps the outcome columns.
`Fast lane` and `Flushed` are mutually exclusive outcomes and sum to the call count
(0 + 22 and 2 + 15 respectively). Do not add `Reattaches` to those outcomes.

Real-profile eligibility: 1,078 of 1,764 panes (61%) before the tab-row fix, all
1,764 after it, subject to the durability check.

### Still unexplained

The worst captured keystroke was queued **117.4 ms**; the binding call accounts
for about **16 ms** of it. The remaining ~101 ms has never been attributed. No
end-to-end typing-lag root cause is established. If lag persists after the
persistence work, the next suspects in order are P7 (duplicate tab minting),
R1/R2 (per-chunk side effects and the status reducer), and G1/G4 (git spawns on
the keystroke loop) — not more persistence work.

## Pinpointed defect — September 7, 12:31–12:32 Phoenix

**Terminal reattachment performs full-session cloning and whole-app synchronous persistence even when the terminal binding already matches.** This is now measured at the actual function boundaries, not inferred from CPU sample percentages. It is a confirmed source of main-thread stalls. A delayed real terminal keydown was captured in the same operation window; this does not assign every millisecond of its delay, or every historical lag report, exclusively to persistence.

The running app changed independently again to PID 67676, build `1.4.198-adhoc.20260907185057`. Verified its registered inspector handler before reopening the localhost debugger. Located the actual live Store through the existing app IPC handler's closure; temporarily wrapped only `persistPtyBinding`, `flushOrThrow`, and the serialization object's `buildStateToSave`. All original property descriptors/methods were restored afterward. No bindings were created or changed by the probe; it observed the user's normal app activity. Renderer IPC probes were read-only `app.getIdentity()` calls at 100 ms intervals, with one request outstanding at most. No CPU profiler ran during this capture.

Four actual local `persistPtyBinding` calls in 30 seconds:

| Start (Phoenix) | Entire binding call | Overlapping renderer→main IPC round trip | Existing binding |
| --- | ---: | ---: | --- |
| 12:31:43.677 | 66.53 ms | 177.3 ms | Tab PTY, leaf PTY and incarnation already match; layout exists |
| 12:31:43.981 | 59.15 ms | 168.8 ms | Same |
| 12:31:47.259 | 60.46 ms | 142.6 ms | Same |
| 12:32:01.681 | 99.80 ms | 232.9 ms | Same |

The full binding call includes a workspace-session clone, then `flushOrThrow`. The four flushes took 48.37–84.38 ms. Twelve `buildStateToSave` calls (normal saves plus binding flushes) each produced about 9.23 MB and took 34.88–43.94 ms, totaling 468.20 ms of synchronous serialization in the 30-second window. These nested durations must not be summed as independent costs.

The renderer captured 69 trusted terminal keydowns. One key's event timestamp was approximately 12:31:47.303, inside the third binding call; its capture listener did not run until 12:31:47.420: **117.4 ms queue delay**. A following key queued 31.8 ms. Most other captured terminal keys queued only a few milliseconds. The binding call ended at about 12:31:47.319, so it does **not** account for the additional ~101 ms before the delayed listener ran. IPC round trips likewise include renderer scheduling after main replies. The measurements establish the synchronous blocker and correlated real input jank, not exclusive attribution of the entire delay to that function.

### Exact implementation chain

`persistPtyIpcSpawnCommit` → `persistAdmittedStablePaneBinding` → `Store.persistPtyBinding` → `cloneWorkspaceSessionState` → `flushOrThrow` → `writeToDiskSync` → `buildStateToSave` → full-state JSON serialization / UTF-8 encoding / hashing, followed by the durable write when necessary.

- `src/main/ipc/pty/ipc/spawn-commit-persist.ts`: the stable-owner persistence path runs on attachment, not just a brand-new terminal.
- `src/main/persistence/loading-store/pty-binding-persistence.ts`: clones the session before setting the binding; there is no equality short-circuit before the clone/flush. Actual probe arguments had matching tab/leaf PTY IDs and incarnation.
- `src/main/persistence/loading-store/primary-state-writes.ts`: the unchanged-state hash comparison occurs **after** `buildStateToSave()`. Even a skipped disk write still pays whole-state serialization/encoding/hashing on main.
- `src/main/persistence/loading-store/state-serialization-secret-handling.ts`: performs the full JSON serialization synchronously. The ostensibly async save path calls the same synchronous builder before its first filesystem await.

The live profile's disk snapshot was 9,372,404 bytes. Top contributors, counted outside Orca without exposing values: `workspaceSession` 4,486,512 bytes; `automationRuns` 3,380,645 bytes (661 entries); `worktreeMeta` 637,426 bytes. Thus attaching one terminal serializes megabytes of unrelated automation history and other workspace state. The older root `orca-data.json` was stale; the live file is under `profiles/local-default/`.

### Fix target, not yet implemented

Put a durability-aware unchanged-binding fast path **before** the full-session clone and serialization, and decouple small PTY-binding durability from whole-app snapshot persistence. Do not merely remove `flushOrThrow` or add `await`: genuine binding changes must remain crash-safe, including mixed-version remote/session ownership cases. In-memory equality alone is insufficient if the matching binding has not yet been durably committed. Normal autosaves also need their synchronous whole-state preparation cost reduced or moved off the main event path.

Evidence: `/var/folders/69/kktjrbf5569d0qvcyxjgmllm0000gn/T/orca-persistence-calls-UD72gC/capture.json`. Earlier primitive-level corroboration: sibling `orca-main-blocking-X0om9Y/capture.json` (PID 16839), including a 92.9 ms IPC request overlapping session cloning and binding-triggered serialization. All diagnostic wrappers were restored; no application fix, settings change, process termination, or app restart was performed by this investigation.

## Final assessment from the available captures — September 7, 12:02 Phoenix

**Confirmed performance defects/conditions:** expensive synchronous durable-state persistence on Electron's main thread; intermittent renderer long tasks; and periods of extreme machine-wide kernel contention. **Not established:** a single causal explanation for the user's perceived typing lag. The real typing capture found fast input dispatch and first-output parsing. Its apparent 99–520 ms post-parse delay is invalid as a paint measurement because of a verified event-ordering race in the diagnostic. Do not use it to justify changing xterm scheduling, synchronized output, or GPU settings.

The final Chromium trace on main PID 16839 / main renderer 16994 ran around 12:00 without CPU profiling or input injection. Across 383 submitted compositor frames, submit-to-presentation latency was median 18.84 ms, p95 19.75 ms, maximum 31.61 ms. Across 171 animation-frame intervals, median was 13.06 ms, p95 14.14 ms, maximum 73.69 ms. The trace had no recorded input-latency events, so it cannot prove keyboard-to-screen latency or retroactively clear the compositor during the earlier typing episode. It does not support a sustained 100–500 ms presentation backlog in this later window.

Trace artifact: `/var/folders/69/kktjrbf5569d0qvcyxjgmllm0000gn/T/orca-chromium-lag-5NBBAV/trace.json` (about 50 MB; kept locally inside a private temporary directory). The actionable code-level finding is the synchronous persistence path described below. A fix to that path needs separate implementation and before/after validation; no blind product fix or setting change was made during this diagnostic task.

Cleanup verified: no renderer debugger attached, no input/timing/phase probe globals or retained diagnostic pane references. Chromium recording was stopped. The localhost Node inspector was scheduled to close after disconnect; port closure was checked separately. No user process was terminated, no restart was initiated, and no input text or terminal content was changed. The only active terminal operation was a zero-byte write and repaint for event-order validation.

## Direct live typing capture — September 7, 11:21–12:00 Phoenix time

### Verified targets and non-restarting debugger access

The app changed independently during this investigation. `orca status --json` identified PID 57789 / renderer 57858, build `1.4.198-hourly.202609071712`, launched at 11:21. Later it identified PID 16839, build `1.4.198-adhoc.20260907181350`. Historical PID 44501 was no longer running; captures were switched to the live instance. No app restart was initiated here.

The earlier debugger-access blocker was overcome: native samples showed Node's `SignalInspector` thread, and a read-only `sysctl(KERN_PROC_PID)` check verified SIGUSR1 was caught rather than ignored/defaulted. After verifying port 9229 was free, sent SIGUSR1 to the exact main PID. Node's localhost inspector opened without restarting. Inspector evaluation confirmed the PID/version and Electron webContents types; the main UI was webContents 1, type `window`, renderer PID 57858—not any of its browser guests. A live DOM check confirmed `document.hasFocus()`, visible document, and focused `.xterm` textarea. Renderer CDP attachment was temporary and detached after each capture.

### Real keystrokes captured, with an important measurement correction

At 11:33:16–11:33:46, the existing typing diagnostic observed 31 direct terminal inputs: 28 single-input observations, one ambiguous two-input burst, one unmatched input. Focused pane at the start/end was leaf `fb249133-0bc3-4ac0-906f-f061b81a1c54`, active terminal tab `049d2c43-a715-49fc-bfa6-63fd85836c9a`, alternate buffer, 155 × 65, status agent type Claude. These identities come from the live renderer, not the CLI's cwd-scoped active terminal.

| Instrumented stage | Median | p95 | Maximum | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Input listener → xterm input dispatch | 0.8 ms | 3.2 ms | 3.6 ms | Excludes OS/Chromium queueing before the listener |
| Dispatch → first associated output parse event | 2.8 ms | 7.2 ms | 9.0 ms | Output association is heuristic, not glyph identity |
| Parse → subsequent public xterm render event | 98.8 ms | 189.4 ms | 520.2 ms | **Not valid as paint latency; see ordering bug below** |

The 28 associated output batches were each 58 bytes, one write. Independent DOM timing captured actual terminal keydown dispatch delays generally around 2–20 ms. The initial 91.6 ms delay overlapped profiler startup and must not be presented as an independent product stall. Renderer timer drift: median 0.6 ms, p95 5.5 ms, max 143.3 ms. Six renderer long tasks lasted 54–106 ms (410 ms total). Neither aggregate idle percentage nor these measurements captures hardware-key-to-displayed-pixel latency.

**Confirmed diagnostic ordering bug:** xterm invokes a write callback before firing `onWriteParsed` (`node_modules/@xterm/xterm/src/common/input/WriteBuffer.ts`). Orca's foreground write callback can synchronously refresh the terminal (`pane-terminal-foreground-render-settle.ts`). The built-in echo diagnostic only queues an observation when `onWriteParsed` arrives, so it can miss the render that has already happened and attribute the *next* content render to this input. Public `terminal.onRender` also excludes redraw-only renders. It cannot be equated with screen presentation.

A live, zero-byte write/repaint check on PID 16839 confirmed the event order without sending PTY input or changing terminal contents: write callback at +0.1 ms; public render and service render at +0.6 ms; `onWriteParsed` after those at +0.6 ms; another service-only render at +12.4 ms. The pane was neither observer-paused nor synchronized-output-held. This proves the measurement race exists on the real runtime, not that this controlled check reproduces the user's lag. The earlier conversational claim that 99–520 ms establishes held terminal redraw is withdrawn. No diagnostic/product implementation fix was applied.

### Confirmed main-thread work and machine contention

The JavaScript profiles identify real main-process blocking work, more precisely than earlier native samples:

- Repeated durable-state serialization: `buildStateToSave`, reached through normal persistence and `flushOrThrow → persistPtyBinding`. The first capture contains sampled non-idle runs approximately 83–106 ms on the latter path, and a 137 ms run including the ordinary save path. These are sampled intervals, not exact instrumented handler durations or correlated keystrokes.
- Native SQLite `run` accounted for about 844 ms sampled self-time over the first 30.8-second profile; synchronous subprocess `spawn` about 241 ms. The second profile had about 276 ms and 113 ms respectively. These totals are not single stalls.
- The second renderer profile was approximately 88.8% sampled idle; the main process approximately 90.7%. That rules out continuous JavaScript saturation in those particular captures, not intermittent stalls or compositor/OS delay.
- At 11:26, `top` reported 3,245–3,248 processes, about 34,500 threads, 0% idle CPU, 84–85% system CPU, and one-minute load above 230. A separate 100-request probe at 11:28 again measured 0% idle / 73% system CPU; main HTTP response median 0.86 ms, p95 29.31 ms, max 342.64 ms. The probe's own timer drift max was 2.16 ms. This confirms severe machine contention and an intermittent main response stall, without assigning all kernel load to one process.
- Two broad `grep -rn` scans from the linear-triage workspace and a recursive project-wide `find ... -exec grep` were still running after roughly 90 minutes. Their existence and CPU usage are confirmed; they alone do not explain 18 cores of kernel load. No searches, agents, or user apps were stopped.

Live census at the typing capture: 727 worktrees, 1,111 terminal tabs / 1,630 unified tabs, roughly 4,900–5,000 store listeners, 12 mounted panes after retention cleanup, 178 stored agent rows. GPU terminal rendering was configured `off`. These are scale/settings observations, not proof of a leak or GPU-related cause.

### Evidence and tooling caveats

- Valid typing/CPU capture: `/var/folders/69/kktjrbf5569d0qvcyxjgmllm0000gn/T/orca-input-lag-3S06gm/` (`input-timing.json`, `terminal-echo.json`, main/renderer `.cpuprofile`).
- Earlier CPU capture: sibling `orca-input-lag-6W47Sw/`. It contained only one keydown and no matched terminal inputs. Its timer-drift data is invalid because the initial inspector adapter omitted the timing probe's 100 ms argument; this was corrected before the valid capture. Its profiler-start frame gap is instrumentation overhead.
- Native samples: `/tmp/orca-1128-renderer.sample.txt`, `/tmp/orca-1128-main.sample.txt`, `/tmp/orca-1130-main.sample.txt`; filename labels are approximate—the report header contains the actual timestamp/PID/version.
- Detailed phase probe: sibling `orca-render-phases-1ItnGv/phases.json` captured zero focused-pane events; it establishes no latency result.
- Diagnostic scripts only were added; targeted syntax/lint checks pass. No persistent setting changes, terminal commands, window activation, or diagnostic uploads were performed.

## Latest conclusion — September 7

No end-to-end typing-lag cause has been established. The earlier synchronous filesystem stall is a confirmed historical main-thread bottleneck, not a demonstrated explanation of the latest recurrence. The latest backend responsiveness measurements below are mostly fast. They leave keyboard dispatch, renderer work, PTY stream delivery and echo-to-paint timing unmeasured; they do not isolate the renderer as the culprit.

Rechecked the running instance: main PID 44501 still has only ports 61004 and 6768 listening, with no renderer remote-debugging endpoint. The browser CDP bridge is scoped to managed browser pages; it is not an established diagnostic connection to Orca's main UI. The Electron skill's existing-instance safety constraint means no automatic restart to enable debugging. No restart or focus change was performed.

Next necessary capture: in the existing Orca window, open View → Toggle Developer Tools → Performance, record about ten seconds while reproducing the typing delay, stop, and save the trace locally. Disable screenshots and avoid sensitive input during capture. This preserves the accumulated runtime state and allows attribution of input delays to JavaScript, layout/paint or scheduling; terminal echo can still require a subsequent PTY-specific measurement if the UI trace is responsive. A clean synthetic app or another aggregate CPU sample is not a substitute.

The prepared capture script was formatted with the project's `oxfmt`; targeted `oxlint` and `node --check` pass after mechanical brace fixes. No application implementation was changed.

## Deeper investigation — September 7: direct responsiveness probes

Sampled the previously omitted terminal daemon (PID 22100). It has survived updates since build `1.4.191-hourly.202608281156`; its protocol is v36. Longevity/version alone is not evidence of a defect. Its ten-second sample had 6,977/7,041 main-thread samples waiting in `kevent`, approximately 99.1% idle. Evidence: `/tmp/orca-sept7-daemon.sample.txt`.

Measured 120 paired read-only requests over 24.47 seconds, at approximately five requests per second: daemon control-socket `ping` and a lightweight main-process HTTP 404 response on port 61004. The diagnostic connection used a unique client ID, did not attach to terminal streams, and closed afterward. Authentication was kept out of output.

| Probe | Median | p95 | Maximum | Over 50 ms |
| --- | ---: | ---: | ---: | ---: |
| Daemon ping | 0.23 ms | 0.52 ms | 73.52 ms | 1 |
| Main HTTP response | 0.45 ms | 14.17 ms | 45.30 ms | 0 |
| Probe's own timer drift | 1.02 ms | 1.15 ms | 1.37 ms | 0 |

These measurements do not reproduce sustained backend unresponsiveness. They do not measure PTY stream queuing, renderer IPC, keyboard handling, or echo-to-paint latency, and do not rule out stalls between requests. A non-interactive `sudo -n fs_usage` attempt also failed because a password is required; no privileged tracing was performed.

Prepared `config/scripts/capture-live-input-lag.mjs`, reusing the existing renderer timing probe. It records bounded keyboard-event timings, input-surface categories, slow frame gaps, long tasks and a JavaScript CPU profile; it does not record key values, input text or terminal output. It needs a Playwright page attached to the main renderer, leaves app focus/state alone, and cleans up its probes. `profileStartWindow` brackets CPU-profiler start in renderer time to aid correlation. This is diagnostic tooling, not an application fix.

Validated against an isolated headless Chromium fixture: keyboard events classified as terminal, a deliberate 100 ms timer task detected, CPU samples present, typed sentinel absent from timing output, and listeners/globals cleaned up. The first fixture used CDP evaluation for the deliberate stall, which did not generate a Long Task entry; moving that workload into a real browser timer made the intended validation pass. This fixture is not a reproduction of the user's Orca lag. Syntax check passes. Prettier was not available through `pnpm exec prettier`.

The installed app still exposes no reachable renderer CDP endpoint. Its View menu has `Toggle Developer Tools` (`src/main/menu/register-app-menu.ts`), so a user-recorded Performance trace while typing can preserve the currently laggy state. Alternatively, an explicitly coordinated relaunch with remote debugging would permit the prepared automated capture, but would clear accumulated state. No restart was performed. The actual user-visible lag root cause remains unproven; the decisive missing evidence is a real input/paint trace, not more aggregate CPU snapshots.

## Live recurrence — September 7, 10:38 Phoenix time

Running build `1.4.198-adhoc.20260907061156`, main PID 44501 and renderer PID 44566, approximately ten hours since launch. Fresh ten-second samples: main has 393/8,279 samples (4.75%) in `__posix_spawn`, but only two in `access`; renderer has approximately 85% in its idle Mach wait. The earlier synchronous access bottleneck did not recur in this capture. These percentages are sampled stack occupancy, not measured keystroke delays.

Recent renderer diagnostics show 38–39 mounted terminal managers, 11 browser guests, JS heap 326–340 MB and private memory 1,082–1,511 MB. Six replay-wedge breadcrumbs at 10:35:40 identify two panes in workspace hash `8a018c17`; three events per pane are not six independent terminal failures. A three-minute trace window contained 191 `show-ref` probes and substantial other Git work. Two VM-stat intervals had zero swap-ins/outs but ongoing decompression; active swapping was not observed.

Long-running background scans continue: a `grep -rn` across projects and Orca application data had run approximately 46 minutes; a `find` across projects executing content searches had run approximately 44 minutes. Their working directories map to linear-triage and a readiness-checklist workspace. Another `find .. -name AGENTS.md` had run approximately 12 minutes. These were not started by this investigation.

Evidence: `/tmp/orca-sept7-main.sample.txt`, `/tmp/orca-sept7-renderer.sample.txt`. Current findings establish subprocess-start overhead and a larger renderer population, with recent replay failures, but still do not correlate a keystroke with a specific blocking function. No restart, process termination, or implementation change was performed.

## Current assessment — updated September 7, 2026

The strongest captured evidence is synchronous filesystem `access()` work on Orca's main thread, reached from a timer: 36.45% of main-thread samples during the reported lag recurrence. This can delay main-thread event handling and terminal IPC. It is not yet a confirmed end-to-end explanation of typing latency: no keystroke timing was correlated with the blocked calls.

The exact JavaScript timer/caller, pathname, and reason the filesystem check took so long remain unknown. Overlapping whole-home skill searches were independently observed creating heavy system load and are a plausible amplifier, not a proven cause of this access stall. Replay warnings, Git probe fan-out, and accumulated renderer resources remain separate observations rather than established typing root causes.

Earlier conversational claims that this fully explained the lag were too strong. The next decisive step is to identify the caller and pathname during recurrence using a JavaScript profile or permitted filesystem tracing, then verify latency before and after a targeted change. No implementation fix has been made. This September 7 update summarizes the September 5 captures; it contains no new live measurements, and recorded PIDs are historical.

User reports slow typing in Orca while Ghostty typing is fast. Running app:
`1.4.198-adhoc.20260906034507`, main PID 87931, renderer PID 87972.

## Initial measurements

- Five-second native samples at 21:44 Phoenix time: renderer main thread approximately 31% outside its idle wait; app main thread approximately 94% in its idle wait. These are sampled occupancy estimates, not keystroke latency measurements.
- At 21:39:22–24, six `terminal_replay_guard_wedged_release` breadcrumbs identified two terminal panes. This is evidence of failed/stalled replay writes, but has not been correlated with the currently laggy pane.
- Recent renderer high-water snapshot: 33 terminal elements, 11,330 DOM nodes, four browser guests, 1,119 stored terminal layouts, approximately 26 MB serialized store, 197 MB JS heap and 1,417 MB private memory. Counts alone do not establish a leak or causal performance problem.
- Ten-minute trace window: 550 `git show-ref` calls, plus other Git operations. Some status/diff calls exceeded one second; asynchronous command durations do not prove main-thread blocking.
- Native samples: `/tmp/orca-live-main.sample.txt` and `/tmp/orca-live-renderer.sample.txt`.
- Logs: `~/Library/Application Support/orca/logs/main.trace.ndjson`.

## Initial assessment

Terminal replay/rendering is a lead, not an established root cause. Ghostty's responsiveness makes Orca-specific work worth investigating. The app has no exposed CDP listener, limiting direct JavaScript profiling without another supported diagnostic entry point. No app processes were stopped and no implementation was changed.

## Deeper checks

- Mapped the replay breadcrumb workspace hash `db7a2eae` to the main Orca repository workspace (`<repo>`), rather than this debug worktree. The two tab hashes were not found in the persisted terminal-tab inventory. No additional wedge breadcrumbs appeared through approximately 21:52. The initial warnings cannot establish the cause of current typing lag.
- Read `replay-guard.ts`: the warning can follow a rejected write (including disposal), or a FIFO probe with no parse progress. The default stalled-write path waits 10 seconds to probe and another quiet 10 seconds before declaring a wedge. It is not a measurement of per-keystroke latency.
- A second, 15-second renderer sample contained 12,899 main-thread samples, including 11,280 in the idle wait: approximately 12.5% outside idle. File: `/tmp/orca-live-renderer-long.sample.txt`. This does not support continuous renderer saturation; short stalls remain possible. Native Electron symbols are insufficient to identify the JavaScript functions responsible.
- Confirmed recurring Git fan-out: recent bursts frequently contain 18 `show-ref` calls, 17 failing, with individual maximum durations around 20–31 ms. Source path: `getPullRequestRemoteRefState` → `listExactRemoteBaseRefs` in `src/main/text-generation/pull-request-remote-ref-probes.ts` → `probeExactRefs` in `src/main/git/exact-ref-probe.ts`. It builds a candidate for every configured remote and runs separate processes with concurrency eight. This explains the observed probe pattern, but does not prove typing stalls.
- Renderer heap fluctuated approximately 194–347 MB in recent minute snapshots, falling back to 194 MB; this is not evidence of steadily growing JS heap. Browser guest count changed from four to five, so native-memory samples do not describe an unchanged workload.
- The profile's `DevToolsActivePort` file names port 9333, but that endpoint is not listening. The running main process's port 56976 did not expose a CDP target list. The file alone is stale evidence, not a usable debugger connection.

## Remaining diagnostic gap

Need the exact laggy surface (embedded terminal versus chat composer, and workspace/agent) and a capture during its slow typing. Current native samples and historical breadcrumbs do not identify an actual keystroke bottleneck. Do not label replay failures, accumulated state, or Git fan-out as the confirmed typing root cause without that correlation. No restart, window activation, or diagnostic upload was performed.

## Improvement after an update/restart — 22:17 Phoenix time

The user reported that typing was less laggy. The original sampled processes no longer exist. Logs record `updater_quit_and_install_started`, native installer invocation, and fresh main/renderer lifecycle events. Current main PID 99632 started at 22:11:35; renderer PID 561 at 22:11:37. The installed version changed from `1.4.198-adhoc.20260906034507` to `1.4.198-adhoc.20260906044334`. This restart was not initiated by this investigation.

- Initial current CPU snapshot: main 1.5%, renderer 3.9%; a subsequent snapshot was 2.3% and 0.1% respectively.
- Post-restart renderer minute snapshots: private memory approximately 207–221 MB versus earlier approximately 772–1,417 MB; JS heap approximately 71–144 MB versus earlier approximately 194–347 MB.
- Browser guests were initially zero, then one, versus four to five before restart.
- No replay-wedge breadcrumbs in the latest six-minute window. Git activity remains substantial (778 recorded Git spans across the window, including startup).

The improvement coincides with an actual update/restart and a much lighter renderer workload. This supports restart-cleared accumulated runtime resources and/or a build change as explanations; it does not distinguish them or establish a leak. A same-build, same-workload keystroke trace during recurrence is still needed for a causal diagnosis.

## Follow-up at approximately 22:56–22:57: confirmed background scan contention

- Latest terminal rendering diagnostics show 12–13 mounted managers, versus roughly 33–35 earlier. Recent renderer JS heap snapshots fall from 167 MB to 133 MB; private memory is approximately 534–587 MB. The resource population is lower, but not identical to just after restart.
- Orca's resource inventory reports 458 managed sessions across 133 workspaces, totaling approximately 65.6 GiB RSS. RSS sums include shared pages and are not unique physical memory. The app's aggregate RSS was approximately 2.55 GiB, including all renderer processes; this is not comparable directly to the main renderer's private-memory breadcrumb.
- The `1.4.198-release` workspace accounted for approximately 346% CPU in the inventory. Direct OS sampling then found `rg` processes at 314%, 351%, and 390% CPU, plus several `find` processes around 33–40% each.
- Confirmed search commands include `find <home> -path */SKILL.md -type f` and `rg -l --hidden --glob SKILL.md prod-release-scan|release scan|production release <home> /tmp`. Two surviving `rg` processes had cwd `<repo>/1.4.198-release`. These scans were launched by other agents, not this investigation.
- System snapshot at 22:56:57: 18 logical CPUs, 3,075 processes, 33,750 threads; CPU 21.21% user, 73.86% system, only 4.92% idle; one-minute load average 17.13. The scan storm is therefore material system contention, not merely a large percentage on one otherwise-idle core.

This establishes a current source of CPU/filesystem pressure: overlapping whole-home skill-discovery scans from release agents. Similar `find` activity appeared in the original capture, but these later scans do not retrospectively prove the original typing bottleneck. The appropriate remediation for this confirmed waste is targeted skill-directory discovery and deduplication across release workers. No agents were messaged, stopped, or modified, and no user processes were killed.

## Lag recurrence at 23:00: main-thread synchronous filesystem blockage

After the user explicitly reported continued lag, concurrent ten-second native samples captured:

- Main PID 99632: 3,033 of 8,321 main-thread samples (36.45%) on a timer callback stack ending in `uv_fs_access` → `access`. This is synchronous filesystem work executing on the Electron main thread. Sampled occupancy does not establish whether this was one continuous stall or several checks.
- Renderer PID 561: 7,705 of 8,541 main-thread samples (90.21%) in its idle Mach wait. The renderer was not continuously CPU-saturated during this capture.
- Two one-second VM-stat intervals showed zero swap-ins, swap-outs, compression, and decompression deltas. Existing swap usage alone is not evidence that this particular stall was caused by active swapping.
- Background `find` scans were still running, including some approximately four minutes old. They could amplify filesystem latency; correlation does not establish which exact path blocked main.

This is the strongest direct Orca-specific finding so far: a timer performs a synchronous filesystem access check on main, potentially blocking input/PTY IPC while the renderer waits. Native samples do not expose the JavaScript function name or path argument. `fs_usage -w -f filesys -t 5 99632` was attempted read-only but refused because it requires root; no elevated command was run. Code inspection found multiple possible synchronous existence/access callers, so no individual function has been assigned blame without proof.

Evidence files: `/tmp/orca-lag-2300-main.sample.txt` and `/tmp/orca-lag-2300-renderer.sample.txt`. Next decisive measurement is a path-level filesystem trace or a JavaScript CPU profile during the same lag, followed by moving the identified periodic filesystem check off main's synchronous path.
