# Incident report: workspace window freezes in a React renderer hot loop

Date: 2026-07-29
Timezone: America/Los_Angeles (PDT, UTC-07:00)
Affected build: Orca `1.4.162-rc.0`
Affected platform: macOS `26.5.1` (`25F80`), Apple Silicon
Status: reproduced in production and isolated Electron; reconnect scan fix validated; exact React setter unproven

## Executive summary

One Orca workspace window became partially responsive while a second Agent Dashboard window in the same desktop app remained fully functional.

The affected window still accepted terminal-tab selection and highlighted the selected tab, but:

- worktree selection no longer changed the workspace;
- the yellow agent-working animation stopped;
- ordinary renderer animation and state transitions appeared frozen.

The backend was healthy throughout. `orca status --json` reported the app, runtime, and graph as ready and reachable. Terminal PTYs and agents continued running.

The immediate failure was a live-but-hot-looping renderer, not a dead backend, blocked PTY, renderer crash, or V8 heap-limit OOM:

- the affected renderer stayed runnable at roughly `123–290%` CPU;
- its physical footprint was about `1.9 GiB`, with a `2.7 GiB` peak;
- process samples found its main thread executing V8/JavaScript for every sample rather than waiting;
- the Orca trace recorded React production error `#185` at `17:50:15.542 PDT`;
- React error `#185` is `Maximum update depth exceeded`;
- the captured stack began with `getRootForUpdatedFiber -> enqueueConcurrentHookUpdate -> dispatchSetStateInternal`;
- memory-heartbeat telemetry stopped only for the affected renderer, while the Agent Dashboard renderer continued emitting normal telemetry.

The machine was also severely saturated: 2,369 processes, 18,467 threads, load around `18–24` on 18 logical CPUs, about `19.36/20 GiB` of swap used, hundreds of agent processes, 509 PTYs, a stale headless Chrome tree burning several cores, and a QEMU Android emulator that intermittently consumed multiple cores. This pressure likely increased the probability or duration of the renderer bug, but it does not explain the React `#185` exception by itself.

The strongest current causal model is:

1. a flapping remote runtime repeatedly changed its reachable status;
2. the sidebar reacted to every status-set transition by requesting a global all-host worktree and lineage refresh;
3. the unusually large worktree/terminal/agent population and host pressure amplified that refresh stream until the workspace renderer entered a synchronous JavaScript/update feedback loop;
4. React reached its nested-update safety limit and emitted `#185`;
5. the renderer remained alive and CPU-bound, so Electron's existing `render-process-gone` recovery did not run;
6. the Agent Dashboard window remained healthy because it used a different renderer process.

The reconnect-driven global scan is now the strongest initiating event and load mechanism.
It does not establish which downstream React setter crossed the nested-update limit.

## User and collaboration context

The user reported that a colleague froze at approximately the same time. Both were connected to the same remote host.

The colleague later found that their Windows remote host setting was continuously
`reconnecting`. Disconnecting that host immediately restored fast worktree-sidebar
scrolling. This report was not independently inspected, but its immediate
cause-and-effect relationship strongly implicates a shared reconnect refresh storm. It
does not prove that both clients hit the same React loop; the colleague's trace and
renderer sample are still needed to establish that.

The inspected Orca worktree records used `hostId: "local"` and `terminalPlatform: "darwin"` on this machine. The user's description of the shared remote-host topology should therefore be preserved separately from the inspected runtime labels rather than silently equating the two.

## User-visible symptoms

Observed before recovery:

- terminal tabs could still be selected;
- selection highlighting updated correctly;
- worktrees could not be switched;
- the yellow working indicator was no longer animating;
- Orca appeared frozen only in the primary workspace window;
- a separately opened Agent Dashboard window remained fully responsive;
- the user also saw an Electron dialog:

  ```text
  A JavaScript error occurred in the main process

  Uncaught Exception:
  Error: Refusing to start E2E outside its disposable home boundary
  ```

The E2E dialog and the workspace renderer freeze were separate failure paths. See [Separate E2E/main-process error](#separate-e2emain-process-error).

## Environment

| Field | Value |
| --- | --- |
| Orca version | `1.4.162-rc.0` |
| Original desktop PID | `92719` |
| Frozen workspace renderer PID | `92772`, renderer client `4` |
| Healthy dashboard renderer PID | `24530`, renderer client `5` |
| Terminal daemon PID | `92773` |
| Runtime ID before restart | `0d531b83-4510-49a1-b4b6-961a704fd83b` |
| Replacement desktop PID | `96542` |
| Replacement workspace renderer PID | `96741`, renderer client `4` |
| Replacement dashboard renderer PID | `4106`, renderer client `5` |
| Runtime ID after restart | `5060148b-ece8-4d60-b53c-20e59043b2a4` |
| OS | macOS `26.5.1` (`25F80`) |
| Logical CPUs | 18 |
| Physical memory | 64 GiB |
| System uptime | 21 days, 2 hours at capture |

## Timeline

Times are PDT.

| Time | Evidence |
| --- | --- |
| `12:24:11` | Frozen renderer PID `92772` launched. |
| `17:44:45` | Affected renderer still emitted an on-time high-memory heartbeat, about 404 MiB used JS heap. |
| `17:45:24` | Two concurrent Git fetches occurred during an already-heavy worktree/status scan period. This is correlation, not proven causation. |
| `17:46:09` | Affected renderer memory heartbeat was delayed; used JS heap was about 417 MiB. |
| `17:49:07` | Last affected-renderer memory heartbeat: 518 MiB used heap, 591 MiB total heap, one browser webview. |
| `17:50:15.542` | Trace recorded `Uncaught Error: Minified React error #185`. |
| `17:50:17.580` | Trace recorded `terminal_webgl_diagnostic`, kind `webgl-atlas-reset`, with 59 live managers. |
| `17:51:03–17:51:09` | Two independent process samples captured the renderer hot loop. |
| After `17:51` | Small/dashboard renderer continued its telemetry while the affected renderer did not. |
| Recovery | In-place reload and graceful quit paths were unresponsive; desktop PID `92719` was terminated with `SIGTERM`. Daemon `92773` survived and was reparented to PID 1. |
| Recovery | Normal `orca open --json` timed out because a headless E2E/repro Orca process was registered without a desktop window. |
| Recovery | `open -n -b com.stablyai.orca` forced a new desktop instance, PID `96542`. |
| Validation | Runtime returned to `ready`; worktrees and live terminals reattached; replacement renderer was no longer continuously pinned in the prior hot loop. |

## Evidence

### 1. Backend and runtime remained healthy

While the workspace window was frozen:

```json
{
  "app": {
    "running": true,
    "pid": 92719,
    "desktopWindowStatus": "available"
  },
  "runtime": {
    "state": "ready",
    "reachable": true,
    "runtimeId": "0d531b83-4510-49a1-b4b6-961a704fd83b",
    "appVersion": "1.4.162-rc.0"
  },
  "graph": {
    "state": "ready"
  }
}
```

The CLI returned this in approximately 27 ms. `orca worktree ps --json` also returned successfully.

This rules out:

- a dead desktop main process;
- a dead runtime;
- an unreachable graph;
- total IPC loss;
- a global terminal-daemon failure.

It does not rule out a renderer event loop that is consuming CPU while only intermittently servicing work.

### 2. The failure was isolated to one window renderer

The user had two windows:

1. the normal workspace window;
2. an Agent Dashboard window.

The workspace window froze, while the Agent Dashboard stayed fully functional.

The process tree matched that report:

- workspace renderer: PID `92772`, renderer client `4`, hot;
- dashboard renderer: PID `24530`, renderer client `5`, responsive.

Renderer-memory telemetry also split the same way:

- the large affected renderer's heartbeat became delayed and then stopped;
- a smaller renderer continued emitting heartbeats after the freeze.

This is strong evidence against an app-wide main-process deadlock. It is a renderer/root-specific failure.

### 3. React recorded `Maximum update depth exceeded`

Original local trace:

```text
/Users/brennanbenson/Library/Application Support/orca/logs/main.trace.ndjson:19781
```

Captured record:

```json
{
  "type": "effect-span",
  "name": "renderer.breadcrumb",
  "startTimeUnixNano": "1785372615542000000",
  "attributes": {
    "kind": "crash-breadcrumb",
    "breadcrumb.name": "renderer_error",
    "breadcrumb.data": {
      "message": "Uncaught Error: Minified React error #185; visit https:/[redacted-path]",
      "filename": "file://[redacted-path]",
      "lineno": 1778,
      "colno": 31,
      "errorType": "Error",
      "errorName": "Error",
      "errorMessage": "Minified React error #185; visit https:/[redacted-path]",
      "errorStack": "Error: Minified React error #185; visit https:/[redacted-path]\n    at getRootForUpdatedFiber (file://[redacted-path])\n    at enqueueConcurrentHookUpdate (file://[redacted-path])\n    at dispatchSetStateInternal (file://[redacted-path])\n    a..."
    }
  }
}
```

The error occurred once in the current trace set:

```text
rg -c -F 'Minified React error #185' main.trace.ndjson*
main.trace.ndjson:1
```

React `#185` means the root exceeded React's nested update limit. This is not a generic "renderer too slow" error.

Important interpretation from Orca's own prior fix `#11326`:

- `nestedUpdateCount` is global to the React root;
- the component that happens to call `setState` after the counter is saturated may be an innocent bystander;
- the short captured stack cannot identify the loop driver;
- a sidebar button, terminal component, portal, or working indicator near the throw site must not be assumed to be causal without a full source-mapped/component stack or deterministic reproduction.

### 4. The captured stack was truncated before the useful component frames

Current renderer diagnostics capture `window.error` in:

```text
src/renderer/src/lib/crash-diagnostics.ts
```

The shared crash sanitizer caps string detail values at 240 characters:

```text
src/shared/crash-reporting.ts
const MAX_STRING_DETAIL_LENGTH = 240
```

That limit reduced the only captured stack to React internals plus `a...`, removing the first application/component frame that could distinguish:

- an unstable state object identity;
- a layout/measurement feedback loop;
- a portal readiness oscillation;
- a store snapshot/subscription loop;
- a ref attach/detach loop;
- worktree/sidebar state churn;
- terminal parking, fit, or WebGL recovery churn.

The 240-character limit is useful for ordinary breadcrumbs but inadequate for the first occurrence of React `#185`.

### 5. The renderer was CPU-bound, not blocked

Representative process observations:

```text
PID    STATE  CPU      RSS
92772  R      179.8%   1,354,016 KiB
92772  R      164.9%   1,338,656 KiB
92772  R      123–290% across later samples
```

The renderer stayed in runnable state `R`.

Two macOS samples were captured:

```text
/tmp/Orca_Helper_(Renderer)_2026-07-29_175103_x5q7.sample.txt
/tmp/Orca_Helper_(Renderer)_2026-07-29_175106_hF2a.sample.txt
```

The first sample observed the Electron/V8 main thread for 2,255 samples. The second observed it for 1,566 samples. In both, the main thread was active for every sample and dominated by V8 microtask, JavaScript call, serialization, JIT, and unresolved JIT-code frames.

The samples did not show the renderer waiting on a lock, socket, or event source.

This supports an active JavaScript/render loop or event storm.

### 6. Renderer memory was elevated but below the V8 heap limit

Process/sample measurements:

| Measurement | Value |
| --- | --- |
| Physical footprint | about 1.8–1.9 GiB |
| Peak physical footprint | 2.7 GiB |
| Writable virtual regions | 2.8 GiB |
| Writable resident | 1.1 GiB |
| Renderer pages already swapped | 579 MiB |
| Last JS used heap | 518 MiB |
| Last JS total heap | 591 MiB |
| Configured V8 heap limit | about 4.2 GiB |

The renderer was memory-heavy and under system memory pressure, but the last JS heap measurement was far below the configured limit. There was no evidence of a V8 heap-limit OOM.

The physical footprint was substantially larger than `ps` RSS and the reported JS heap, so non-JS allocations, graphics, mapped resources, terminal surfaces, and swapped writable memory mattered.

### 7. Renderer heartbeat cadence proves event-loop loss

The affected renderer's normal memory breadcrumb cadence degraded:

```text
17:44:45  normal heartbeat, ~404 MiB used JS heap
17:46:09  delayed heartbeat, ~417 MiB
17:49:07  delayed final heartbeat, 518/591 MiB
afterward  no affected-renderer heartbeat
```

The smaller/dashboard renderer continued emitting heartbeat breadcrumbs after that point.

This is stronger than a screenshot-level "the animation stopped" report: a renderer-owned interval itself stopped being serviced in the affected renderer only.

### 8. Worktree, terminal, and agent population was extreme

The Orca graph reported:

```text
tracked worktrees: 261
result truncated: true
worktrees returned: 200
```

Within only the first 200 returned worktrees:

```text
worktrees with live terminals: 142
sum of liveTerminalCount: 438 before restart, 439 after restart
worktrees with status "working": 9
agent states: 219 done, 20 working in the first incident snapshot
```

Because the result was truncated at 200 of 261 worktrees, `438` is a lower bound, not a guaranteed global total.

The raw `orca worktree ps --json` result was 11,636 lines and roughly 210,850 tool-output tokens before truncation. The CLI snapshot is not proof that the renderer receives the identical JSON payload, but it demonstrates the size and fan-out of the live graph the UI represents.

Largest returned terminal populations included:

| Worktree | Live terminals |
| --- | ---: |
| `pr-8783-internal-review` | 14 |
| `pr-9190-internal-review` | 14 |
| `mobile-9717-dup-sessions` | 9 |
| `Submit images as feedback` | 7 |
| `mobile-6927-close-tabs` | 7 |
| `mobile-6863-android-scroll` | 7 |
| `mobile-pr-10148` | 7 |
| `orca-trust-dialog` | 7 |

The renderer emitted:

```json
{
  "breadcrumb.name": "terminal_webgl_diagnostic",
  "breadcrumb.data": {
    "managers": 59,
    "kind": "webgl-atlas-reset"
  }
}
```

In current source, `liveManagers` is a module-level set in:

```text
src/renderer/src/lib/pane-manager/pane-manager-registry.ts
```

The code documents managers as approximately terminal tabs. `resetAndRefreshAllTerminalWebglAtlases()` synchronously iterates all managers once to reset and again to refresh.

The 59-manager reset happened about two seconds after the React error. It is evidence of a large mounted terminal surface and expensive global work. It is not proof that WebGL reset started the React loop.

### 9. The host was heavily saturated

System snapshot:

| Metric | Captured value |
| --- | ---: |
| Logical CPUs | 18 |
| Load average | `23.61 24.84 24.09` |
| Processes | 2,369 |
| Threads | 18,467 |
| PTYs | 509 |
| `uptime` users | 508 |
| Physical memory in use | about 62/64 GiB |
| Compressed memory | about 28 GiB |
| Swap used | 19,228.81 MiB / 20,480 MiB |
| Swap free | 1,251.19 MiB |
| Disk free | about 381 GiB |
| Observed I/O | about 6,500–8,800 IOPS, 42–59 MiB/s |

`uptime`'s `508 users` should be interpreted as login/PTY sessions, not 508 human users. The independently counted 509 PTYs corroborates that interpretation.

`memory_pressure` reported no throttled pages and a 43% system-wide memory-free percentage at the instant it was sampled. A brief `top` interval showed no active swap-in/out. Therefore:

- swap was nearly exhausted and the system had performed enormous historical compression/swap work;
- the brief evidence did not prove active swap thrashing at the exact sample moment.

Disk capacity was healthy, so a full disk was not involved.

### 10. Agent processes consumed tens of GiB

Counts fluctuated while agents started and exited, but incident snapshots found:

| Process class | Count range | Aggregate RSS |
| --- | ---: | ---: |
| Claude | 117 | about 22.8–23.3 GiB |
| Codex | 252–320 | about 10.7–11.6 GiB |
| Node | about 38 | about 1.2 GiB |
| Orca renderers | 3 | about 1.7 GiB by `ps`; affected renderer footprint was higher by `vmmap` |

These totals do not include all descendants, file mappings, compressed pages, or swapped writable regions.

### 11. A stale headless Chrome tree was burning several cores

An `agent-browser` process tree had been alive for about 7 days and 23 hours:

```text
PID 2617  agent-browser-darwin-arm64
PID 2648  headless Google Chrome
```

Seven Chrome helpers repeatedly consumed approximately `35–100%` CPU each:

- GPU helper near `100%`;
- network service near `96%`;
- storage service near `95–97%`;
- one renderer near `100%`;
- three more renderers around `35–90%`.

Aggregate snapshots placed this tree around `500–700%` CPU, or roughly five to seven logical cores.

This tree was not killed during recovery because ownership by another agent or test was not established.

### 12. Other transient high-CPU processes

Examples:

- Android QEMU PID `89397`, device `@orca_pr9190_api36`, observed from about `12%` to `390%` CPU and roughly `1.6–2.8 GiB` RSS;
- an Expo dev server briefly at `128.6%` CPU;
- Vitest workers at more than `80%` CPU;
- WindowServer around `65%` in one snapshot;
- continuous Git scans and worktree status operations.

The values are time samples, not stable allocations, but they show that the 18-core machine had little scheduling slack.

### 13. Git/worktree background activity was high

In an approximately 12-minute trace slice around the incident:

```text
git worktree calls: 107
git remote calls: 98
git status calls: 65
```

Two fetches overlapped near `17:45:24`, close to the first renderer-heartbeat delay.

This is correlation. Git calls ran in the main process and continued completing after the renderer error, which further supports a healthy main process and an isolated renderer failure.

## Separate E2E/main-process error

The visible Electron dialog said:

```text
Error: Refusing to start E2E outside its disposable home boundary
```

The guard is in:

```text
src/main/startup/configure-process.ts
```

It runs when `ORCA_E2E_USER_DATA_DIR` is set and verifies that Node's `homedir()` matches the declared disposable E2E home before using the E2E profile.

Important evidence:

- the frozen production main PID `92719` had no `ORCA_E2E_*` variables in its process environment;
- the production main process had been running for more than five hours;
- therefore this startup-only E2E exception did not originate from the already-running frozen main process;
- it came from a separate or transient Orca/E2E launch.

There was a live headless repro process tree:

```text
PID 99457  Orca CLI: serve --port 6795 --mobile-pairing
PID 99612  Orca: --serve --serve-json --serve-port 6795
```

Both carried:

```text
ORCA_E2E_USER_DATA_DIR=/tmp/repro6713/userData
```

However, PID `99612`'s GPU and network helpers showed:

```text
--user-data-dir=/Users/brennanbenson/Library/Application Support/orca
```

That discrepancy needs a separate isolation investigation: a process marked as E2E/repro appeared to create Chromium helpers against the production profile path.

It also affected recovery:

1. after desktop PID `92719` exited, `orca open --json` returned `runtime_open_timeout`;
2. no normal desktop process appeared;
3. the headless Orca process was still registered as a running Orca application;
4. `open -n -b com.stablyai.orca` forced a distinct desktop instance and succeeded.

The E2E process was left running because it could belong to another active repro agent.

Conclusions:

- the E2E exception is not the direct cause of the React renderer loop;
- stale/headless app registration and production-profile leakage made restart less reliable;
- this is a related robustness bug worth fixing alongside, or tracking separately from, renderer recovery.

## Recovery sequence and outcome

### Attempt 1: in-place renderer reload

The intended least-disruptive recovery was `CmdOrCtrl+R` in the affected window.

The computer-control provider could capture the Orca window, but the frozen window would not accept focus. Retrying with window restore still returned `window_not_focused`. Clicking and activating the app did not make keyboard delivery verifiable.

Result: reload shortcut could not be delivered.

### Attempt 2: graceful app quit

An AppleScript quit request returned successfully, but after 10 seconds:

```text
PID 92719  still running
PID 92772  still runnable at ~158% CPU
```

The current window-close code includes a renderer-ack timeout intended to destroy an unresponsive window, but the observed quit did not complete.

Result: graceful quit path did not recover the app.

### Attempt 3: terminate the desktop main process

`SIGTERM` was sent only to desktop PID `92719`.

The desktop process exited after about four seconds. No agent, Claude, Codex, QEMU, Chrome, or worktree process was intentionally killed.

Terminal daemon PID `92773` survived:

```text
PID    PPID  STATE
92773  1     Ss
```

### Attempt 4: reopen

`orca open --json` timed out because the headless `repro6713` Orca instance was registered without a desktop window.

The forced new-instance launch succeeded:

```text
open -n -b com.stablyai.orca
```

New desktop PID: `96542`.

### Validation after recovery

`orca status --json`:

```json
{
  "app": {
    "running": true,
    "pid": 96542,
    "desktopWindowStatus": "available"
  },
  "runtime": {
    "state": "ready",
    "reachable": true,
    "runtimeId": "5060148b-ece8-4d60-b53c-20e59043b2a4",
    "appVersion": "1.4.162-rc.0"
  },
  "graph": {
    "state": "ready"
  }
}
```

The graph still reported:

```text
tracked worktrees: 261
worktrees with live terminals in returned slice: 142
liveTerminalCount in returned slice: 439
```

The active local worktree was restored as:

```text
I18n architecture improvements
/Users/brennanbenson/orca/workspaces/orca/scylla
liveTerminalCount: 5
```

Replacement renderer observations:

```text
workspace renderer PID 96741: initially ~9% CPU, later variable ~14–72% during restore
dashboard renderer PID 4106: ~3% CPU
```

The new workspace renderer showed normal variability rather than remaining pinned at the prior `160–290%` hot-loop level.

## Recurrence in the replacement renderer

The replacement workspace renderer reproduced the same user-visible failure class about
18 minutes after launch, without a desktop-process, runtime, graph, daemon, or dashboard
failure.

At `18:18 PDT`, while the workspace UI appeared stuck again:

```text
desktop PID 96542:             alive
workspace renderer PID 96741:  runnable, ~100–117% CPU, up to 1,472,992 KiB RSS
dashboard renderer PID 4106:   responsive, generally low CPU
runtime:                       ready and reachable
graph:                         ready
```

`orca status --json` returned normally with the same desktop PID and runtime ID. An
independent `orca worktree ps --json` also completed and returned 257 tracked worktrees
before truncation. The backend remained usable while the workspace renderer was hot.

A two-second process sample captured the recurrence:

```text
/tmp/Orca_Helper_(Renderer)_2026-07-29_181809_jmia.sample.txt
```

The sample observed the renderer main thread for all 1,555 samples in an active
V8/JavaScript/microtask call chain. It did not show the main thread parked on a lock or
event source. The sample measured a 1.6 GiB physical footprint and a 1.7 GiB peak.

### Heartbeat degradation repeated

The dashboard renderer, identifiable by its small heap and zero browser webviews,
continued its approximately once-per-minute memory telemetry. The larger workspace
renderer became progressively late:

| Renderer | Time | Used / total JS heap | Interpretation |
| --- | --- | --- | --- |
| Workspace | `18:12:05` | `866 / 948 MiB` | on-time interval |
| Dashboard | `18:12:17` | `36 / 80 MiB` | healthy |
| Workspace | `18:13:11` | `401 / 995 MiB` | about 6 seconds late |
| Dashboard | `18:13:17` | `25 / 80 MiB` | healthy |
| Dashboard | `18:14:17` | `42 / 81 MiB` | healthy |
| Workspace | `18:14:24` | `874 / 1,060 MiB` | about 13 seconds late |
| Dashboard | `18:15:17` | `43 / 83 MiB` | healthy |
| Workspace | `18:15:50` | `645 / 1,046 MiB` | about 26 seconds late |
| Dashboard | `18:16:17` | `42 / 84 MiB` | healthy |
| Workspace | `18:17:24` | `456 / 1,027 MiB` | about 34 seconds late |
| Dashboard | `18:18:17` | `33 / 85 MiB` | healthy |
| Dashboard | `18:19:17` | `39 / 90 MiB` | healthy |

This is the same per-window event-loop-starvation pattern as the first occurrence. The
workspace heartbeat degraded while the other window's renderer continued on schedule.

### Similar terminal-manager and WebGL churn preceded the recurrence

Before the recurrence, the trace recorded repeated worktree activations, terminal safe-fit
retry exhaustion, and WebGL atlas resets. The live manager count rose from 29 at
`18:10:00` to 42 by `18:14:07`. The first occurrence had the same classes of breadcrumbs
with 59 live managers.

This correlation makes terminal park/unpark, fit, manager lifecycle, and WebGL recovery
high-priority replay inputs. It still does not prove that WebGL or a terminal manager was
the React loop driver.

### No second React `#185` was recorded

The rotating trace set contains only the original `17:50:15.542` React `#185` record:

```text
main.trace.ndjson:    0 occurrences
main.trace.ndjson.1:  1 occurrence, original incident at line 19781
```

Therefore the recurrence is confirmed to be the same renderer-local hot-loop and
heartbeat-failure class, but the available evidence does not prove that the second
occurrence crossed React's nested-update limit or had the identical initiating setter.
The two occurrences may share the same driver without producing a second observable
`window.error`, or they may be two related renderer feedback loops under the same load.

### User-initiated `Cmd+R` restored progress

At `18:19:23.552`, the trace recorded, in the existing PID `96741`:

```text
renderer_bootstrap_started
renderer_memory reason=startup
renderer_bootstrap_rendered
```

The user confirmed that they initiated this renderer reload with `Cmd+R`. No desktop,
daemon, runtime, graph, or dashboard restart accompanied it. After the reload:

- workspace CPU dropped from a sustained `~100–117%` to variable `~15–37%`;
- RSS dropped from as high as about 1.47 GiB to about 517 MiB;
- workspace telemetry resumed at `18:20:23`;
- terminal-manager reconstruction restarted from one manager and rose to seven.

This result establishes that a user-delivered `Cmd+R` is a successful, least-disruptive
recovery for this live-renderer hot loop. It also strongly supports a bounded per-window
reload as the corresponding automatic recovery mechanism: the workspace can be restored
without terminating the desktop process or disrupting the healthy dashboard and backend.

### Host pressure was worse during the recurrence

At recurrence capture:

```text
load averages: 54.10 42.54 31.29
logical CPUs:  18
```

Other simultaneous consumers included a TypeScript/Go linter near `341%` CPU, several
stale headless-Chrome helpers near one core each, an Android emulator near one core, and
a TypeScript compiler above half a core. This pressure can explain delayed scheduling and
can amplify the product bug, but it cannot by itself explain why only the workspace
renderer stayed in an active JavaScript call chain while the dashboard and backend
continued to progress.

At `18:51 PDT`, a later process census attributed the machine-wide CPU load to several
independent trees:

```text
stale headless agent-browser Chrome tree:  ~392% CPU, running for eight days
iOS 26.5 Simulator tree:                    ~336% CPU across 597 processes
production Orca main/renderer/GPU:          ~175% CPU combined
two Android emulators:                       ~35% CPU combined
Claude/Codex/Node processes:                >140% CPU combined
total machine process count:                 2,740
```

The eight-day Chrome tree was the clearest abnormal long-lived consumer. No process from
that tree was stopped during this investigation because it was not launched by the
investigating session.

### Remote-runtime reconnect scanning is the strongest trigger evidence

The colleague's immediate recovery after disconnecting a continuously reconnecting
Windows runtime led to a matching code path in
`src/renderer/src/components/sidebar/index.tsx`.

Before the fix, every change to the set of reachable runtime environments requested:

```text
fetchAllWorktrees() -> fetchWorktreeLineage()
```

That is a global all-host refresh. A `SingleFlightCoalescer` prevented overlapping calls,
but a status stream that continued to flap could keep producing one leading scan and one
trailing scan indefinitely.

The global path was already redundant. Commit `bbc5951958` added the host-scoped
`runtimeProjectRefreshScheduler` in `useIpcEvents` four days after the sidebar effect was
introduced. The scoped scheduler:

- refreshes only the affected environment's repo catalog and worktrees;
- debounces bursts;
- enforces a five-second minimum interval per environment;
- runs the existing focused-host lineage merge without invoking `fetchAllWorktrees`.

Trace volume matches the broad-scan hypothesis. One rolling ten-minute sample captured
during investigation contained:

```text
git worktree: 169
git remote:   136
git status:   112
```

A later rolling ten-minute window still contained 155 `git worktree`, 112 `git remote`,
and 80 `git status` spans, including bursts of 38–51 `git worktree` commands per minute.
The runtime and graph continued to report healthy during this activity.

The implemented fix removes the sidebar's runtime-status-driven global refresh and its
now-unused coalescer. The existing repo-count-triggered broad refresh remains, while
runtime reconnect discovery continues through the per-environment scheduler. A regression
test repeatedly alternates one runtime between connected and unreachable and asserts that
the sidebar never starts `fetchAllWorktrees`.

This evidence identifies a concrete reconnect load storm and a defensible fix. It does
not conclusively identify the application setter below React's
`dispatchSetStateInternal`, so the longer first-failure stack remains necessary.

### Isolated Electron reproduction

The branch was launched through `config/scripts/run-electron-vite-dev.mjs` with:

```text
branch/worktree: brennanb2025/fix-electron-freeze-repro / anchovy
renderer URL:    http://127.0.0.1:5177/
CDP endpoint:    http://127.0.0.1:9337/
profile:         disposable ORCA_DEV_USER_DATA_PATH
```

The app identity API confirmed the intended worktree. The isolated profile was populated
through Orca's real repo IPC with:

```text
repo rows:                  13
visible worktrees:         266
detected worktree records: 3,458
```

The old sidebar reconnect effect was temporarily restored under HMR to replay the failure
path, then removed again before final validation.

With the pre-fix effect:

- 60 alternating reachable/unreachable transitions caused 27
  `fetchAllWorktrees` calls;
- a longer 600-transition run caused 139 calls;
- the 600-transition run took 35.7 seconds;
- mean / p95 / max animation-frame gaps were `59.5 / 124.6 / 272.5 ms`;
- the renderer reached `140.9%` CPU and a 2.1 GiB physical footprint;
- all 2,353 main-thread samples in the active capture were inside
  V8/JavaScript/microtask execution.

Active sample:

```text
/tmp/orca-anchovy-prefx-runtime-flap-active-renderer.sample.txt
```

With the fixed source after an in-place renderer reload:

- the same 600 transitions caused zero `fetchAllWorktrees` calls;
- the run completed in 18.2 seconds;
- mean / p95 / max frame gaps improved to `30.3 / 49.5 / 150.1 ms`;
- peak observed RSS during the run was about 735 MiB;
- real wheel events moved the visible worktree sidebar from `scrollTop=0` to
  `scrollTop=2400`, then from `2419` to `10419`, after the run.
- after the stress stopped, interval CPU returned to `0.0%` and 120 idle animation
  frames averaged `8.3 ms` with a `9.2 ms` p95 and `9.3 ms` maximum.

Visible proof:

```text
/tmp/orca-anchovy-fixed-runtime-flap-sidebar-scrolled.png
```

The replay used a synthetic Windows-runtime status entry injected into the real Zustand
store because the disposable profile had no paired remote host. It exercised the exact
sidebar status dependency and all-host scan path, but it did not exercise an actual
Windows transport reconnect or emit a second React `#185`. The active JavaScript hot-loop,
CPU, and memory failure class were nevertheless reproduced.

### Validation status

Validation completed:

- 6 focused Vitest files, 118 tests passed;
- sidebar reconnect regression passed;
- runtime refresh scheduler tests passed;
- both existing React `#185` regression suites passed;
- crash stack-length regression passed;
- focused `oxlint` passed;
- renderer/web TypeScript check passed;
- `git diff --check` passed.

The isolated app also exposed an unrelated startup limitation: its long disposable profile
path made the daemon Unix-socket path invalid, so the dev app fell back to local PTYs.
This did not affect the sidebar/runtime-status reproduction.

## Confirmed facts, likely contributors, and unknowns

### Confirmed

1. One workspace-window renderer entered a CPU hot loop.
2. A different Agent Dashboard renderer remained healthy.
3. The main process, runtime, graph, and terminal daemon remained healthy.
4. The affected renderer emitted React `#185`.
5. The affected renderer's own heartbeat stopped.
6. The affected renderer was alive and runnable, so crash-only recovery did not apply.
7. Host CPU, memory, process, PTY, and I/O pressure was extreme.
8. Restarting the desktop while preserving the daemon restored Orca and its live sessions.
9. A separate headless E2E/repro process interfered with normal reopening.
10. Runtime status transitions could initiate a global all-host worktree refresh from the sidebar despite an existing host-scoped scheduler.
11. The old effect reproduced a 140.9%-CPU, 2.1-GiB renderer JavaScript hot loop in isolated Electron; the fixed source issued zero global scans under the same status workload.

### Likely contributors

1. A flapping remote runtime repeatedly triggered the redundant global sidebar refresh.
2. Large numbers of mounted terminal managers and live terminal/worktree state increased synchronous renderer work.
3. Continuous agent status/output changes increased update frequency.
4. Host pressure widened timing windows and delayed normal renderer tasks.
5. A state/effect/layout/ref feedback loop converted one update source into unbounded nested updates.
6. The lack of live-renderer hang recovery allowed the loop to persist indefinitely.

### Not proven

1. The 59-manager WebGL atlas reset caused the React loop.
2. The reconnect-driven scans directly caused the exact React setter loop rather than an equivalent JavaScript hot loop that amplified another downstream defect.
3. The sidebar or yellow indicator component contained the setter that crossed React's update-depth limit.
4. The remote host sent malformed data rather than an ordinary but repeated reconnect transition.
5. The colleague hit React `#185`.
6. Memory pressure alone caused the freeze.
7. The separate E2E exception caused the renderer freeze.

## Related React `#185` history already in this repository

This repository has several recent fixes for distinct `#185` loops:

| Commit / PR | Mechanism |
| --- | --- |
| `4543bb6826` / `#11326` | Bounded Activity portal readiness `loading <-> unavailable` oscillation. |
| `17617b1a6c` / `#10632` | Preserved pane-title overlay rect object identity to stop equal-state layout churn. |
| `7a422712b1` / `#10028` | Fixed Voice speech-model dropdown update loop. |
| `9038a78d37` | Stopped terminal overlay measure/fit/ResizeObserver feedback loop. |
| `f01bfd937f` / `#8679` | Upgraded Radix and React to stop React 19 callback-ref identity churn. |
| `58293445e1` / `#9615` | Guarded status-bar notice anchor state against equal-geometry re-renders; explicitly not a proven root fix for its crash cluster. |

Current dependencies already include:

```json
{
  "radix-ui": "^1.6.2",
  "react": "^19.2.7",
  "react-dom": "^19.2.7"
}
```

Therefore, do not assume this is simply the old Radix `1.4.3` bug recurring.

The recurring patterns in prior fixes are highly relevant:

- a fresh object written to state despite equal logical value;
- a `useLayoutEffect` sync-lane feedback loop;
- measurement causing fit/resize causing measurement;
- portal readiness oscillation;
- unstable ref identity;
- the component where `#185` throws being an innocent bystander.

## Current recovery and observability gaps

### 1. Recovery only handles a renderer that exits

`src/main/window/createMainWindow.ts` recovers on:

```text
webContents.on('render-process-gone', ...)
```

This renderer never went away. It remained alive and CPU-bound.

No main-window handler for Electron's `unresponsive` event was found.

### 2. The watchdog covers the main thread, not renderer windows

`src/main/hang-watchdog/main-thread-hang-watchdog.ts` monitors the packaged macOS main process from a worker.

That watchdog correctly did not fire here because the main process was healthy. There is no equivalent per-renderer heartbeat/recovery controller.

### 3. PTY code can detect unresponsive renderer IPC but only logs

`src/main/ipc/pty.ts` can time out a delivery-resync probe and logs:

```text
[pty] delivery resync probe unanswered — renderer IPC unresponsive
```

The code explicitly performs no mutation because it expects a reload to cure dead IPC. That signal could feed a bounded per-window recovery/prompt path.

### 4. First-failure stack detail is too short

The first and only `#185` stack lost its application frames due to the 240-character breadcrumb cap.

### 5. The UI had no usable "reload this window" escape hatch

The renderer would not accept the keyboard reload shortcut, and graceful quit did not complete.

### 6. Headless E2E instances can interfere with desktop open

The normal open command targeted or detected a no-window headless Orca process and timed out.

## Recommended fix plan

### Priority 0: isolate runtime reconnect refreshes

1. Do not run `fetchAllWorktrees` when a remote runtime's status changes.
2. Route connect and reconnect discovery through `runtimeProjectRefreshScheduler`.
3. Keep refresh state scoped per runtime environment.
4. Retain the normal all-host refresh for actual repo-catalog count changes.
5. Regress repeated reachable/unreachable transitions against global scan calls.

### Priority 0: capture the actual loop driver

1. Special-case the first React `#185` occurrence:
   - retain a substantially longer sanitized stack;
   - preserve source-map frames;
   - record the renderer surface and `webContents.id`;
   - include the React error boundary component stack when available;
   - include the last bounded set of store/effect diagnostics.
2. Keep later identical events coalesced so an error storm cannot fill the breadcrumb ring.
3. Record a renderer heartbeat sequence and lag:
   - expected timestamp;
   - actual timestamp;
   - event-loop delay;
   - pending terminal write/ACK totals;
   - live manager and pane census;
   - active worktree/tab;
   - high-level store collection sizes.
4. Preserve the first `#185` diagnostic bundle even if the renderer never exits.

### Priority 0: recover a live-but-unresponsive window

Add per-window recovery rather than app-wide recovery:

1. Main process tracks a heartbeat from each main renderer window.
2. Treat missing heartbeat plus Electron `unresponsive` or unanswered PTY resync as a renderer-hang candidate.
3. Capture diagnostics before mutation.
4. Surface a native/main-process-controlled recovery prompt:
   - `Reload workspace window`;
   - `Wait`;
   - `Restart Orca`.
5. Reload only the affected workspace window when safe.
6. Preserve live PTYs using the same orphan-sweep protection already used by `render-process-gone` recovery.
7. Use a circuit breaker so a deterministic loop cannot cause infinite auto-reloads.
8. Leave the healthy Agent Dashboard window intact.

Automatic reload should require strong evidence and remain bounded. A user-driven reload prompt is safer for loops that recur immediately.

### Priority 1: audit high-probability update loops

Focus on code exercised by:

- worktree activation and sidebar status;
- agent working-state updates;
- Activity portal reconciliation;
- terminal tab cold parking;
- pane title/overlay geometry;
- ResizeObserver and `useLayoutEffect` measurement;
- global WebGL atlas reset/refresh;
- external-store/Zustand selectors used by the sidebar and workspace shell.

For every state setter in those paths:

- return the previous reference when the logical state is unchanged;
- avoid allocating a new array/object snapshot on every `getSnapshot`;
- guard layout measurements with field equality and appropriate rounding;
- bound two-state readiness oscillations;
- keep effect dependencies and subscriptions stable;
- avoid synchronous store write-back from a selector/subscriber;
- avoid global manager work when only one visible pane needs recovery.

### Priority 1: reduce mounted and subscribed surface area

At this scale, validate that:

- inactive worktrees do not keep terminal React trees mounted unnecessarily;
- cold-parked terminal tabs release renderer-heavy objects and subscriptions;
- the pane-manager registry does not retain managers after unmount;
- sidebar rows subscribe to the narrowest stable scalar state;
- agent spinner updates do not rerender the full worktree list;
- graph updates are batched;
- worktree switching does not synchronously reconcile hundreds of inactive terminal surfaces;
- WebGL recovery is chunked or scoped when a global reset is unavoidable.

### Priority 1: isolate headless E2E/repro app identity

1. Ensure every E2E/serve launch sets and uses the disposable Electron `userData` and home paths before Chromium helpers spawn.
2. Ensure headless serve/repro instances cannot claim or confuse the production desktop singleton.
3. Ensure `orca open` selects a desktop-capable process or starts a new desktop window when only headless instances exist.
4. Add a regression test for:
   - headless E2E instance running;
   - production desktop stopped;
   - `orca open`;
   - desktop window becomes available;
   - no production profile path appears in E2E helper arguments.

### Priority 2: resource-pressure hygiene

Resource cleanup will not replace a renderer-loop fix, but it should reduce recurrence:

- detect obviously orphaned agent-browser trees;
- expose per-worktree process and terminal cost;
- make done-agent cleanup visible and safe;
- warn when PTY/process/swap thresholds are extreme;
- avoid indefinitely retaining dormant E2E daemons and emulator processes;
- provide ownership metadata before offering cleanup.

## Required regression tests

### Runtime reconnect isolation test

1. Create a large local graph and one paired runtime.
2. Alternate that runtime between reachable and unreachable status.
3. Assert that no transition invokes `fetchAllWorktrees`.
4. Assert that the connected environment still refreshes through
   `runtimeProjectRefreshScheduler`.
5. In Electron, verify sidebar scrolling and animation heartbeats remain responsive while
   the status flaps.

### Renderer update-loop stress test

Create a deterministic fixture approximating this incident:

- 250–300 worktrees;
- at least 450 live terminal records;
- at least 59 mounted/live pane managers;
- hundreds of done agent records;
- 15–25 actively changing agent statuses;
- continuous terminal output;
- two renderer windows: workspace plus Agent Dashboard;
- periodic Git/worktree metadata updates;
- periodic WebGL atlas recovery signal;
- repeated worktree switches.

Assertions:

- no React `#185`;
- animation/requestAnimationFrame heartbeat continues;
- worktree activation completes within a bounded interval;
- terminal-tab selection and worktree selection both update;
- dashboard remains responsive;
- renderer commit count settles after equal-state updates;
- no unbounded manager, DOM-node, or heap growth;
- renderer CPU returns toward idle after the event burst.

### State identity tests

For high-risk selectors and geometry/readiness helpers:

- equal inputs return the previous reference;
- subscription snapshots remain referentially stable;
- repeated identical ResizeObserver deliveries add at most one settling commit;
- readiness state cannot oscillate indefinitely;
- store subscribers do not synchronously write back to the same slice.

### Per-window recovery test

1. Open workspace and dashboard windows.
2. Deliberately block or spin the workspace renderer test hook.
3. Verify main process and dashboard remain responsive.
4. Verify a renderer-hang diagnostic is captured.
5. Reload only the workspace window.
6. Verify existing PTYs reattach without duplicate sessions or lost output.
7. Verify the recovery circuit breaker stops repeated reloads.

### E2E/headless-open isolation test

1. Launch a headless E2E/serve process with disposable paths.
2. Confirm every child helper uses those paths.
3. Invoke `orca open`.
4. Confirm a desktop window appears.
5. Confirm the E2E process cannot redirect the production open request into a no-window runtime.

## Reproduction strategy

The original incident was not triggered by an intentional click. Build a replay rather than relying on manual timing:

1. Capture or synthesize the worktree/terminal/agent graph at the observed cardinality.
2. Alternate one paired runtime between reachable and unreachable while recording refresh calls.
3. Replay agent-state and terminal-output events at field-observed rates.
4. Open a second Agent Dashboard window.
5. Exercise Activity portal staging and worktree switching.
6. Trigger terminal park/unpark and atlas recovery at controlled points.
7. Run under both normal and CPU-throttled conditions.
8. Record:
   - React Profiler commits;
   - renderer heartbeat lag;
   - state setter call sites;
   - store version/snapshot identities;
   - layout-effect transitions;
   - manager registration/unregistration;
   - PTY ACK backlog.

Start with macOS because that is the observed platform, then cover Windows, Linux, SSH-hosted workspaces, and folder workspaces.

## Diagnostic commands used

These are read-only unless explicitly noted.

```sh
orca status --json
orca worktree ps --json
ps -axo pid,ppid,state,%cpu,%mem,rss,etime,command
memory_pressure
sysctl vm.swapusage
uptime
sample 92772 3 1
```

Compact graph census:

```sh
orca worktree ps --json | jq '{
  total: .result.totalCount,
  returned: (.result.worktrees | length),
  active_worktrees: [.result.worktrees[] | select(.liveTerminalCount > 0)] | length,
  live_terminals: ([.result.worktrees[].liveTerminalCount] | add),
  working_worktrees: [.result.worktrees[] | select(.status == "working")] | length,
  agent_states: (
    [.result.worktrees[].agents[]?.state]
    | group_by(.)
    | map({state: .[0], count: length})
  )
}'
```

React error lookup:

```sh
rg -n -F 'Minified React error #185' \
  '/Users/brennanbenson/Library/Application Support/orca/logs/main.trace.ndjson'
```

## Evidence preservation

At report creation time, the following files still existed:

```text
/Users/brennanbenson/Library/Application Support/orca/logs/main.trace.ndjson
/Users/brennanbenson/Library/Application Support/orca/logs/daemon.log
/tmp/Orca_Helper_(Renderer)_2026-07-29_175103_x5q7.sample.txt
/tmp/Orca_Helper_(Renderer)_2026-07-29_175106_hF2a.sample.txt
/tmp/Orca_Helper_(Renderer)_2026-07-29_181809_jmia.sample.txt
```

The `/tmp` samples and rotating trace logs are ephemeral. Copy them into a durable, access-controlled diagnostic bundle before reboot, cleanup, or log rotation if the raw artifacts are needed.

Do not publish the full process list or terminal output without reviewing it for secrets and user content.

## Open questions

1. What was the first Orca application frame below `dispatchSetStateInternal`?
2. Did the colleague's renderer record React `#185` at the same time?
3. Which shared host/runtime event occurred immediately before both users froze?
4. Was Activity portal readiness involved despite the `#11326` bound?
5. Did any state-identity loop remain in terminal/worktree/sidebar code added after earlier `#185` fixes?
6. Why were 59 pane managers live in one renderer?
7. Were all 59 expected, or did manager unregistration leak?
8. Did the atlas reset begin before the truncated trace timestamp, or was the recorded reset strictly a post-error recovery action?
9. Why did the graceful quit renderer-ack timeout not close the affected window?
10. Why did a process with `ORCA_E2E_USER_DATA_DIR=/tmp/repro6713/userData` spawn helpers using the production profile path?
11. Why did `orca open` target or defer to a headless no-window instance?
12. Can per-window renderer heartbeat/recovery reuse the existing PTY delivery-resync and orphan-sweep mechanisms?

## Bottom line

This was an Orca renderer correctness bug exposed under an extreme but legitimate multi-agent/worktree workload.

The replacement renderer reproduced the same hot-loop and heartbeat-failure class in less
than 20 minutes. A continuously reconnecting remote runtime and the sidebar's redundant
global all-host refresh now provide the strongest initiating-event explanation. Host
saturation was severe and amplified the storm, but the product bug is that an ordinary
runtime reconnect stream could repeatedly rescan unrelated hosts until one live renderer
entered an unbounded JavaScript/update loop. The first occurrence is confirmed as React
`#185`; the recurrence is not, and the exact setter remains unproven.

The fix should combine:

1. host-isolated, throttled runtime reconnect refreshes;
2. better first-failure `#185` diagnostics;
3. deterministic reconnect stress reproduction;
4. state/effect identity fixes if the longer stack reveals a downstream loop;
5. bounded per-window live-renderer recovery;
6. headless E2E/desktop-open isolation.
