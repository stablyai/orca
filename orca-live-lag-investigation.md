# Orca live lag investigation — September 5, 2026

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

- Mapped the replay breadcrumb workspace hash `db7a2eae` to the main Orca repository workspace (`/Users/jinjingliang/Documents/projects/orca`), rather than this debug worktree. The two tab hashes were not found in the persisted terminal-tab inventory. No additional wedge breadcrumbs appeared through approximately 21:52. The initial warnings cannot establish the cause of current typing lag.
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
- Confirmed search commands include `find /Users/jinjingliang -path */SKILL.md -type f` and `rg -l --hidden --glob SKILL.md prod-release-scan|release scan|production release /Users/jinjingliang /tmp`. Two surviving `rg` processes had cwd `/Users/jinjingliang/Documents/projects/orca/1.4.198-release`. These scans were launched by other agents, not this investigation.
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
