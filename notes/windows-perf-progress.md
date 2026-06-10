# Windows Performance Investigation — Progress Log

Goal: (1) significantly improve Windows startup time (~1 min cold start reported),
(2) fix OpenCode-driven UI freezes, (3) improve overall Windows performance.
All changes must be proven with before/after benchmark numbers.

## Status

- [x] Benchmark harness for startup time (`tools/benchmarks/startup-time-bench.mjs`)
- [x] Startup bottleneck FIXED + verified: **19.31s → 1.80s median** (fixture);
      real-world profile was 62s of blocked main thread → now 0 icacls spawns steady-state
- [x] OpenCode freeze ROOT CAUSE found + fixed: MessagePart hook flood (see F5/D2).
      Benchmark: 22.9 MB / 540 ms / 400 main-process fanouts per turn → 469 KB / 79 ms / 120
      (legacy vs throttled plugin behavior through the real hook HTTP pipeline)
- [x] General Windows sync-work audit (results below); audit item #2 (readHooksJson per
      status IPC) investigated and found NOT hot — renderer barely calls those handlers.
      Fixed pre-existing Windows-only test failures (hydrate-shell-path delimiter).
- [x] Windows ConPTY e2e perf validation (F7 below)

## Key facts / environment

- Branch: `Jinwoo-H/windows-launch-time`
- Electron app, entry: `src/main/index.ts` (~1557 lines)
- Existing startup diagnostics: `ORCA_STARTUP_DIAGNOSTICS=1` writes `[startup] <event>` lines to stderr
  (`src/main/startup/startup-diagnostics.ts`)
- Prior art: PR #4618 "perf: speed up desktop startup", #5011 "stop main-thread PowerShell ACL storm
  on env-store reads", #4526 "Avoid OpenCode config cleanup freezes on Windows", b240d5eee
  "Measure startup hydration phases"

## Follow-ups / known issues (out of scope for this branch)

- Pre-existing Windows-only unit test failures: `daemon-pty-adapter.test.ts` (61) and
  `history-manager.test.ts` (3, chmod-based fs-error simulation is a no-op on Windows).
  Identical with/without this branch's changes. CI never sees them (ubuntu-only).
- Consider a Windows CI lane for the terminal-perf e2e suite (F6/F7) and these unit suites.
- Typing-latency load-sensitivity (F7): possible deeper work on daemon checkpoint
  scheduling/priority if user reports persist after D3.
- Audit leftovers (F4): non-recursive `grantDirAcl` execFileSync on hook install
  (installer-utils.ts:210) could be async; readHooksJson caching unnecessary (not hot).

### D3 — Async checkpoint writes (implemented)

`HistoryManager.checkpoint` (every ~5s per dirty session, Electron main process) switched
from writeFileSync+renameSync (~1MB snapshot JSON, inflated by Defender on Windows) to
fs.promises with the same tmp+rename atomicity; ordering preserved by the adapter's
checkpointInFlight guard.

## Suspects (startup)

1. **`grantDirAcl(userData, { recursive: true })`** — `src/main/index.ts:517-523`, win32 only,
   runs **synchronously on the main process inside `openMainWindow()` before window creation**.
   Spawns `icacls <userData> /grant:r <user>:(OI)(CI)(F) /T /C` with a **60s timeout**.
   The comment itself admits large userData dirs (tens of thousands of Chromium cache files)
   can take >10s. This blocks first paint for the whole walk. Matches "1 minute launch" and
   "Windows only".
2. Windows Defender real-time scan of exe/asar/native modules on cold start (environmental,
   can't fix in code, but reducing file count / sync IO helps).
3. TBD: store sync load, daemon init, i18n init, sherpa-onnx native module load.

### F3 — Baseline benchmark (2026-06-10)

Harness: `node tools/benchmarks/startup-time-bench.mjs --label baseline --iterations 3 --files 28000`
(28k-file synthetic Chromium-cache-shaped userData fixture in %TEMP%, headless launch of
the electron-vite build with `ORCA_STARTUP_DIAGNOSTICS=1`, milestones parsed from stderr).

| phase (median of 3) | baseline |
|---|---|
| spawnToAppReady | 857ms |
| appReadyToServices | 178ms |
| servicesToI18n | 2ms |
| i18nToOpenWindow | 7ms |
| **aclGrantMs** | **15.65s** |
| windowCreatedToLoaded | 1.06s |
| **totalToDidFinishLoad** | **19.31s** |

ACL walk = 81% of total. (Fixture is kinder than the real profile: same file count but
freshly-written small files → real %APPDATA%\Orca measured 62s for the same command.)
JSON: tools/benchmarks/results/startup-baseline-2026-06-10T19-36-01-305Z.json

### F4 — Sync main-thread audit (subagent, 2026-06-10)

Ranked offenders beyond the ACL grant (#1):
2. `readHooksJson` + JSON.parse re-read per agent-status IPC call across ~10 hook services
   (`src/main/*/hook-service.ts` via `agent-hooks/installer-utils.ts:50`) — 10-100ms per
   status snapshot, all platforms. Remediation: in-memory cache.
3. `whoami.exe` SID resolution (win32-utils.ts:92) — already cached, OK.
4. macOS-only `defaults read` per browser probe — not Windows.
5. `installer-utils.ts:210` non-recursive grantDirAcl on hook install (execFileSync,
   500ms-2s) — infrequent write path, low priority.
6. `secure-file.ts` sync PowerShell on credential write path — by design (#5011), leave.

## Suspects (OpenCode freeze)

- User report: UI freezes ~5s after sending prompt; OpenCode session itself continues fine
  (visible from external terminal). So the agent process is healthy — the freeze is in Orca's
  main process or renderer. Spinner in left panel still animates (= renderer compositor alive?
  or just that one timer). Need to find sync main-process work triggered by OpenCode activity.
- Prior fix #4526 "Avoid OpenCode config cleanup freezes on Windows" — re-check that path.

### Research results (subagent, 2026-06-10) — ranked candidates

1. **ConPTY output flood vs PTY batching/backpressure** (HIGH): Windows ConPTY re-renders
   full TUI frames → 10-100x output volume vs macOS. Batching in `src/main/ipc/pty.ts`
   (16KB chunks / 8ms flush, 512KB renderer in-flight window). If renderer xterm.write is
   slow, ACKs stall → in-flight fills → main stalls. Tests: terminal-foreground-redraw-freeze,
   artificial-opencode-terminal-load e2e.
2. **Sync `runtime.onPtyData` per data event before batching** (MED-HIGH):
   `src/main/ipc/pty.ts:1376-1430` → `orca-runtime.ts:3256-3420`: normalizeTerminalChunk +
   tail-buffer append + agent-status OSC parsing run synchronously per chunk on main.
   Daemon PTY path. High event rate × per-event cost can saturate the main loop.
3. **`mirrorUserConfig` recursive fs work in `buildPtyEnv` on PTY spawn** (MED):
   `src/main/opencode/hook-service.ts:359-524` + `pty/overlay-mirror.ts:63-110` —
   readdir/safeRemoveTree/symlinks on main thread at spawn; #4526 fixed only clearPty side.
   Timing mismatch with "5s after prompt" though.
4. Agent-status event fan-out per OSC title (LOW-MED). 5. Tail-buffer O(n²) (LOW).

Gap in coverage: no test exercises rapid continuous ConPTY-scale data + sync onPtyData
accumulation on Windows.

### F5 — ROOT CAUSE (2026-06-10): OpenCode MessagePart hook flood

Eliminated candidates first: ran `terminal-foreground-redraw-freeze.spec.ts` on THIS Windows
machine (real ConPTY + daemon provider) — passes; renderer output scheduler protections hold.
The raw TUI-output-flood theory doesn't explain an OpenCode-specific permanent freeze.

The actual mechanism (src/main/opencode/hook-service.ts plugin source):
- OpenCode publishes `message.part.updated` with the FULL accumulated text of the part on
  every streamed append (architecture: parts are republished, not deltas).
- Orca's plugin POSTed that full text to the agent-hook server on EVERY event →
  **O(n²) bytes per streaming turn**. A 120KB reply in 400 updates = ~23 MB through
  loopback HTTP + main-process JSON.parse; real turns are worse (per-token updates).
- Main process spends its whole loop on HTTP receive + parse + normalize + fanout. UI symptom
  matches the user report exactly: everything dead (window close needs main + renderer
  round-trip), EXCEPT the sidebar agent indicator — which is the one thing fed by the very
  agentStatus:set flood that's starving everything else.
- Why Windows-biased: same flood exists on macOS but combines on Windows with ConPTY
  full-frame redraw volume and generally slower process IO; also Windows daemon-PTY path
  adds main-process onPtyData work.
- Why "5 seconds after sending the prompt": that's when the accumulated text gets big.
- Why OpenCode keeps working: plugin POST failures are swallowed; the session is healthy.
- Downstream payloads were already bounded (prompt 200 chars, lastAssistantMessage 8000
  chars via agent-status-types normalization) — the renderer wasn't the bottleneck; the
  main-process ingest was.

### F7 — Windows ConPTY e2e perf validation (2026-06-10)

Ran the terminal-perf budget specs on this Windows machine (real ConPTY + daemon PTY
provider — a path CI never exercises):
- `terminal-output-scheduler.spec.ts`: PASS (all tests)
- `terminal-foreground-redraw-freeze.spec.ts`: PASS
- `terminal-typing-latency.spec.ts`: PASSES in isolation, repeatedly — median 13.6-23.1ms,
  worst 34-42ms (budgets: 250ms median / 1000ms worst). Two earlier runs that exceeded the
  worst-key budget (1054.9ms, 2016.1ms outlier on a single key) occurred while other heavy
  tooling (vitest/tsgo/builds) ran concurrently on the machine → load-sensitivity, not a
  deterministic product defect. Note the product implication: under heavy host load
  (exactly what coding agents generate), a keystroke can stall >1s on Windows. Plausible
  contributors for follow-up: daemon checkpoint ticks (5s interval; snapshot serialize in
  daemon + sync writeFileSync of checkpoint JSON on main — daemon-pty-adapter.ts:592,
  history-manager.ts:109), Defender scanning fresh build artifacts.

### F6 — Windows e2e perf coverage gap

All terminal-perf e2e specs run on ubuntu-latest in CI. Verified they DO run on a Windows
dev machine (`npx playwright test ... --project electron-headless` works locally). Consider
a Windows CI lane for the terminal-perf suite.

## OpenCode fix (D2)

1. **Plugin throttle + cap (source fix)** — `src/main/opencode/hook-service.ts`:
   assistant MessagePart posts are trailing-edge coalesced to ≥250ms apart and text is
   capped at 4000 chars (leading edge posts immediately so previews stay snappy; pending
   snapshot flushed before SessionIdle so the done-row preview is the final message; user
   prompts bypass the throttle slot). Plugin file is rewritten on every Orca-launched
   OpenCode spawn, so the fix deploys to new sessions immediately.
2. **Listener-side cap (stale-plugin defense)** — `src/shared/agent-hook-listener.ts`:
   OpenCode MessagePart text capped at 8000 chars at ingest (OPENCODE_HOOK_TEXT_MAX_CHARS)
   so pre-fix plugins in long-running OpenCode processes can't blow up state maps.
3. **Benchmark/regression test** — `src/main/agent-hooks/opencode-message-part-flood-bench.test.ts`
   drives the real hook HTTP pipeline with both behaviors. Measured on this machine:
   | metric/turn | legacy plugin | throttled plugin |
   |---|---|---|
   | posts | 400 | 120 |
   | bytes through main | 22.9 MB | 469 KB (49x less) |
   | wall time | 540 ms | 79 ms |
   | listener fanouts | 400 | 120 |
4. Behavioral plugin tests — `src/main/opencode/hook-plugin-message-part-throttle.test.ts`
   executes the generated plugin with fake timers + stubbed fetch.

## Findings

### F1 — Recursive icacls walk is the ~1 min startup (CONFIRMED, 2026-06-10)

- This machine's real packaged-Orca userData: `%APPDATA%\Orca` = **28,650 files / 2.06 GB**
  (mostly Chromium caches: Cache, Code Cache, GPUCache, blob_storage…).
- Measured the exact command Orca runs in `openMainWindow()` (src/main/index.ts:517-523):
  - `icacls <userData> /grant:r <user>:(OI)(CI)(F) /T /C` → **62.0 s**
  - App runs it with `execFileSync` (main thread, BLOCKING, before BrowserWindow creation)
    with a **60s timeout** → every cold launch freezes ~60s, then the grant *times out and
    silently fails* (execFileSync throws, caught). Users pay the full minute and get nothing.
  - Non-recursive root-only grant: **4.8 s** (NTFS propagates inheritable ACE internally).
  - `icacls <userData>\* /grant:r …` (immediate children, 48 entries): **4.7 s**.
- Why it exists (PR #1152): Chromium's BrowserWindow ctor resets userData DACL with
  Inherit-Only ACEs → EPERM on writes in existing subdirs (codex-runtime-home, agent-hooks…).
  Explicit child ACEs survive propagation. Per-write EPERM retries exist as backstop in
  `codex-accounts/fs-utils.ts` + `agent-hooks/installer-utils.ts`.
- Windows ACL inheritance recalculates from the immediate parent during propagation, so
  explicit ACEs on userData + immediate children are sufficient; per-file ACEs on 28k
  Chromium cache files are useless work.

### F2 — Instrumentation prior art

- `ORCA_STARTUP_DIAGNOSTICS=1` → `[startup] <event>` lines on stderr (startup-diagnostics.ts).
  Only 2 events exist today (single-instance lock). Commit b240d5eee (branch
  perf/startup-first-window, NOT merged here) has a full StartupPhaseTimer framework —
  too large to cherry-pick; adding minimal milestone logs instead.
- Hermetic benchmark launch path: `ORCA_E2E_USER_DATA_DIR=<dir>` redirects userData
  (works packaged + dev), `ORCA_E2E_HEADLESS=1` keeps window hidden. Dev/preview mode
  skips single-instance lock → safe alongside installed Orca.

## Decisions / fixes

### D0 — RESULTS: ACL fix benchmark (2026-06-10)

| phase (median) | baseline (3 it.) | after fix (4 it.) | steady state (3 it.) |
|---|---|---|---|
| aclGrantMs | **15.65s sync/blocking** | async (off critical path) | **0ms (marker hit)** |
| totalToWindowCreated | 18.25s | 930ms | 814ms |
| totalToDidFinishLoad | **19.31s** | **2.04s** | **1.80s** |

- First launch after fix: total 2.06s while the background grant ran 6.81s concurrently.
- Marker verified written by real icacls run; subsequent launches log `acl-grant-done
  mode=marker-hit` with zero spawns.
- JSON evidence: tools/benchmarks/results/startup-{baseline,acl-fix,acl-fix-steady}-*.json
- Files: src/main/startup/windows-user-data-acl.ts (+tests), src/main/index.ts (wire-up +
  startup milestones), src/main/win32-utils.ts (export identity resolver),
  tools/benchmarks/startup-time-bench.mjs (harness).

### D1 — ACL grant fix (implemented as planned)

Replace the synchronous recursive walk with:
1. A persisted marker (`windows-acl-grant.json` in userData, keyed on identity + scheme
   version): when present → skip everything (steady-state launches: 0 icacls spawns, 0 ms).
2. When marker missing (first launch after install/profile import): grant root +
   immediate children via **async spawn** (never blocks window creation); write marker
   on success. Per-write EPERM retries remain the backstop during the async window —
   that's exactly what they're for (#1152 comment says so).
3. Drop the /T full-tree walk entirely; it grants nothing the immediate-children
   ACEs + inheritance propagation don't already cover.
