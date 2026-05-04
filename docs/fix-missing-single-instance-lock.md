# Fix: Missing single-instance lock corrupts `orca-runtime.json` + `endpoint.env` on every relaunch

**Issue:** [#1312](https://github.com/stablyai/orca/issues/1312)
**Status:** Proposed fix
**Approach:** Add `app.requestSingleInstanceLock()`, clear owned metadata on clean exit, and sweep orphaned sockets on startup.

## Problem

Orca v1.3.24 does not call `app.requestSingleInstanceLock()`. Every launch of the AppImage / `.app` bundle starts a new Electron main process that unconditionally:

1. Opens a fresh Unix socket `o-<NEW_PID>-<runtimeId-prefix>.sock`.
2. Atomically rewrites `<userData>/orca-runtime.json` with the new pid / socket / runtimeId / authToken, clobbering the previously-running instance's metadata.
3. Picks a new random port and rewrites `<userData>/agent-hooks/endpoint.env` with the new port + token.

The earlier Orca keeps its socket + hook-port alive, but the canonical metadata files no longer point at it. When the most-recent instance quits, the socket is `rmSync`'d in `OrcaRuntimeRpcServer.stop()` but the metadata file is left pointing at the dead pid. `orca status` then returns `runtime.state = 'stale_bootstrap'` even though earlier Orca instances are still running healthily.

### Root cause

Three distinct gaps in the main-process lifecycle:

1. **No single-instance lock.** `grep -rn requestSingleInstanceLock src/` returns zero matches. Every launch boots a full second Electron process instead of focusing the existing window.
2. **No metadata clear on clean exit.** `src/main/runtime/runtime-metadata.ts:29` exports `clearRuntimeMetadata()` but it is never called. The `will-quit` handler in `src/main/index.ts:516` stops the RPC server (removes the socket) but leaves `orca-runtime.json` on disk pointing at a dead pid + missing socket. The safety comment in `src/main/runtime/runtime-rpc.ts:132-136` explicitly declines to clear metadata, citing the risk of erasing another live runtime's bootstrap during restarts / updates / dev overlap — that concern is real but is the *symptom* of missing single-instance, not a principled design.
3. **No startup sweep of orphaned sockets.** A process killed by SIGKILL / OOM-kill skips `OrcaRuntimeRpcServer.stop()` entirely, leaving `o-<dead-pid>-*.sock` files in `<userData>/` with no cleanup path. The reporter observed three such orphans on a single live system.

### Symptom (from the issue)

Healthy state with one orca running (pid 50926):

```json
{
  "app":     { "running": true, "pid": 50926 },
  "runtime": { "state": "ready", "reachable": true, "runtimeId": "2ad0..." },
  "graph":   { "state": "ready" }
}
```

After launching a second instance and quitting it while the first stays open:

```json
{
  "app":     { "running": false, "pid": null },
  "runtime": { "state": "stale_bootstrap", "reachable": false, "runtimeId": null },
  "graph":   { "state": "not_running" }
}
```

The `stale_bootstrap` branch is distinguished at `src/cli/runtime/status.ts:17-20` — "metadata file exists but pid not running" vs. "no metadata at all".

### Affected code

- `src/main/index.ts` — app lifecycle entry; `app.whenReady` at line 315, `will-quit` at line 516.
- `src/main/runtime/runtime-rpc.ts` — `OrcaRuntimeRpcServer.start()` line 51, `stop()` line 112 (with the deferred-cleanup comment at lines 132-136).
- `src/main/runtime/runtime-metadata.ts` — `writeRuntimeMetadata` / `readRuntimeMetadata` / `clearRuntimeMetadata`.
- `src/main/agent-hooks/server.ts` — `writeEndpointFile` line 1299, `stop()` line 1223 (with a parallel deferred-cleanup comment at lines 1230-1237).
- `src/shared/runtime-bootstrap.ts` — `RuntimeMetadata` shape and `getRuntimeMetadataPath()`.
- `src/main/startup/configure-process.ts` — `configureDevUserDataPath(isDev)` redirects dev runs to `orca-dev` userData.
- `src/cli/runtime/status.ts` — CLI reader, never writes metadata.

## Architecture

### Current (buggy) state

Every launch boots a new Electron main. All live instances race on the same `orca-runtime.json` / `endpoint.env`, and SIGKILL'd predecessors leave orphaned sockets behind.

```
                <userData>/ (e.g. ~/.config/orca)
                ┌────────────────────────────────────────────┐
                │ orca-runtime.json   ← clobbered on every   │
                │                       launch (last writer  │
                │                       wins, pid may be     │
                │                       dead)                │
                │ agent-hooks/endpoint.env  ← same race      │
                │ o-<pid-A>-*.sock    (live, owned by A)     │
                │ o-<pid-B>-*.sock    (orphan — B SIGKILL'd) │
                │ o-<pid-C>-*.sock    (orphan — C OOM-killed)│
                └────────────────────────────────────────────┘
                          ▲            ▲            ▲
                          │ writes     │ writes     │ writes
                          │            │            │
                  ┌───────┴──┐  ┌──────┴───┐  ┌─────┴────┐
                  │ Electron │  │ Electron │  │ Electron │
                  │   #1     │  │   #2     │  │   #3     │
                  │ (live,   │  │ (live,   │  │ (quit;   │
                  │  hook    │  │  hook    │  │  left    │
                  │  HTTP)   │  │  HTTP)   │  │  stale   │
                  └──────────┘  └──────────┘  │  meta)   │
                                              └──────────┘
                          ▲
                          │ reads orca-runtime.json
                          │ → sees wrong/dead pid
                  ┌───────┴───────┐
                  │ CLI (status)  │ reports 'stale_bootstrap'
                  └───────────────┘
```

### Post-fix state

A single Electron owns the userData. Second launches fire `second-instance` and exit. The ownership guard at `clearRuntimeMetadataIfOwned()` protects the auto-updater handoff. Sweep runs at startup.

```
                <userData>/
                ┌────────────────────────────────────────────┐
                │ orca-runtime.json   ← one writer (pid A)   │
                │ agent-hooks/endpoint.env                   │
                │ o-<pid-A>-*.sock    (live, owned by A)     │
                │ (orphans swept on next start)              │
                └────────────────────────────────────────────┘
                          ▲
                          │ writes
                  ┌───────┴──────────────┐
                  │ Electron #1 (holds   │──── hook HTTP ──►
                  │ single-instance lock)│
                  └──────────▲───────────┘
                             │ 'second-instance' event
                  ┌──────────┴───────────┐
                  │ Electron #2 (boots,  │
                  │ lock fails, focuses  │
                  │ #1's window, quits)  │── transient, no writes
                  └──────────────────────┘
                          ▲
                          │ reads orca-runtime.json
                  ┌───────┴───────┐
                  │ CLI (status)  │ reports 'ready'
                  └───────────────┘

Ownership guard site: src/main/runtime/runtime-metadata.ts
  → clearRuntimeMetadataIfOwned(userData, ownedPid, ownedRuntimeId)
```

### Data flow

**Happy path — single instance steady state**

```
[user action] → Electron #1 main loop
  → Electron #1 RPC server (Unix socket) handles IPC
  → hook HTTP server answers localhost requests
  → orca-runtime.json unchanged (only written at start)
  → CLI reads orca-runtime.json → 'ready'
```

**First-launch cold start**

```
[launch] → configureDevUserDataPath(is.dev)    (startup/configure-process.ts)
  → app.requestSingleInstanceLock() → true     (main/index.ts)
  → sweepOrphanedRuntimeSockets(userData)      (runtime-rpc.ts start())
  → OrcaRuntimeRpcServer.start() binds o-<pid>-*.sock
  → writeRuntimeMetadata({pid, runtimeId, ...}) (runtime-metadata.ts)
  → agent-hooks server writes endpoint.env
  → openMainWindow()
```

**Second-launch rejected**

```
[launch] → configureDevUserDataPath(is.dev)
  → app.requestSingleInstanceLock() → false    (lock held by #1)
  → app.quit()                                  (transient process exits)
  → Electron #1 receives 'second-instance' event
  → Electron #1 restores + focuses mainWindow
  → no writes to orca-runtime.json or endpoint.env
```

**Auto-updater handoff (two orderings, both safe)**

```
Ordering X: old clears first
  old.runtimeRpc.stop() rmSync's o-<oldPid>-*.sock
  old.clearRuntimeMetadataIfOwned() — current.pid == oldPid → clear
  new.writeRuntimeMetadata() — fresh file, no conflict

Ordering Y: new writes first
  new.writeRuntimeMetadata() — file now points at newPid/newRuntimeId
  old.clearRuntimeMetadataIfOwned() — current.pid != oldPid → SUPPRESSED
  new continues undisturbed

Invariant: the ownership guard (pid + runtimeId match) is what makes
both orderings safe. Without it, Ordering Y would erase the new
process's just-written metadata.
```

## Proposed fix

Three surgical changes, in decreasing order of importance:

### 1. Single-instance lock (primary — kills ~90% of the bug surface)

In `src/main/index.ts`, immediately **after** `configureDevUserDataPath(is.dev)` (line 89) and **before** any handler registration or `app.whenReady(...)`, gate the rest of the module on a new helper `acquireSingleInstanceLock()` (see "Helper extraction" in the testing section):

```ts
function focusExistingWindow(): void {
  // Why: focus the existing window instead of spawning a parallel Electron
  // process that would clobber orca-runtime.json and endpoint.env.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  // Pre-window case: the active instance is still booting and will call
  // openMainWindow() from whenReady(). No action needed here.
}

if (!acquireSingleInstanceLock(app, focusExistingWindow)) {
  if (is.dev) {
    console.log(
      'Another Orca instance is already running against this userData path — focusing existing window.'
    )
  }
  app.quit()
  // Why: early-return is what prevents the service constructors and handler
  // registrations below (whenReady, before-quit, will-quit, etc.) from
  // running in a process that is already losing the lock race.
  return
}
// All existing app lifecycle setup below.
```

**Placement rationale (from codex review):** the lock must come *after* `configureDevUserDataPath(is.dev)` so dev (`orca-dev` userData) and packaged (`orca` userData) instances lock in separate namespaces — Electron derives the lock identity from the `userData` path. Placing it before would force dev and packaged builds to serialize against each other, which is the opposite of the current dev/prod isolation contract.

**Dev-mode behavior:** kept unconditional. `configureDevUserDataPath` already isolates `pnpm dev` from packaged runs, so devs who want two instances already get the answer by running both a packaged build and a dev build. Allowing multi-instance against the same userData reopens the exact corruption this fix targets.

**Dev-mode ergonomics:** when the lock fails in dev mode, write a single `console.log('Another Orca instance is already running against this userData path — focusing existing window.')` immediately before `app.quit()`. This makes the behavior discoverable in the `pnpm dev` console so internal devs don't mistake a silent exit for a broken launcher. Packaged runs skip the log — there's no attached console.

### 2. Clear owned metadata on clean exit (secondary — hardens `stale_bootstrap` reporting)

Add a guarded clear in `src/main/runtime/runtime-metadata.ts`:

```ts
/**
 * Why: clearing metadata unconditionally would race with a sibling Orca
 * process during auto-updater handoff or dev/prod overlap — see the comment
 * in runtime-rpc.ts:132-136. The ownership guard preserves the original
 * safety invariant while still letting us report 'not_running' (not
 * 'stale_bootstrap') after a clean exit.
 */
export function clearRuntimeMetadataIfOwned(
  userDataPath: string,
  ownedPid: number,
  ownedRuntimeId: string
): void {
  const current = readRuntimeMetadata(userDataPath)
  if (!current) return
  if (current.pid !== ownedPid) return
  if (current.runtimeId !== ownedRuntimeId) return
  clearRuntimeMetadata(userDataPath)
}
```

In `src/main/index.ts` `will-quit` handler (line 516-548), the clear must be **awaited before Electron exits**, not fire-and-forget. The existing handler uses a two-pass `preventDefault()` pattern with `disconnectDaemon().finally(app.quit())`. The existing `void runtimeRpc.stop().catch(...)` at line 530-534 currently fires independently of that chain; Electron may exit before `runtimeRpc.stop()` resolves, and a `.then(clear)` appended to it would race the second-pass `app.quit()`. Fold both into the awaited chain instead — and do the work **inside** the `!daemonDisconnectDone` guard so `runtimeRpc.stop()` fires exactly once, on the first pass:

```ts
if (!daemonDisconnectDone) {
  e.preventDefault()
  // Why: capture ownership synchronously (before any await) so the guard
  // still has the right pid/runtimeId to compare against if shutdown
  // partially clears global state. Evaluating these inside .then() would
  // let a later teardown path null them out mid-chain.
  const ownedPid = process.pid
  const ownedRuntimeId = runtime?.getRuntimeId()
  // Why: the construction AND the allSettled() must both live inside the
  // `!daemonDisconnectDone` guard. The will-quit handler re-fires after
  // app.quit() below; without this guard, the second pass would re-invoke
  // runtimeRpc.stop() (redundant rmSync on an already-removed socket) and
  // re-run the ownership-guarded clear against a metadata file that may
  // now belong to the auto-updater's replacement process.
  const rpcStopAndClear = runtimeRpc
    ? runtimeRpc
        .stop()
        .then(() => {
          if (ownedRuntimeId) {
            clearRuntimeMetadataIfOwned(app.getPath('userData'), ownedPid, ownedRuntimeId)
          }
        })
        .catch((error) => {
          console.error('[runtime] Failed to stop local RPC transport:', error)
        })
    : Promise.resolve()
  // Why: Promise.allSettled — we need BOTH the daemon disconnect and the RPC
  // stop + owned-metadata clear to complete before Electron exits. Using
  // allSettled (not all) preserves the existing fail-open posture: if
  // disconnectDaemon rejects, we still quit instead of hanging the app.
  Promise.allSettled([disconnectDaemon(), rpcStopAndClear]).then(() => {
    daemonDisconnectDone = true
    app.quit()
  })
}
```

Remove the standalone `void runtimeRpc.stop().catch(...)` at line 530-534 — it is folded into `rpcStopAndClear` above.

**Why compare-before-clear is not over-engineering:** `autoUpdater.quitAndInstall()` quits the old process immediately and relaunches. The new process may already be starting (writing its own metadata) while the old `will-quit` is running. An unconditional clear would delete the new process's fresh metadata. Codex confirmed this is the correct posture.

### 3. Orphaned-socket sweep on startup (tertiary — hygiene)

In `OrcaRuntimeRpcServer.start()` (`src/main/runtime/runtime-rpc.ts:51`), before creating the new listener, enumerate `<userData>/o-*.sock` and remove any whose pid component is dead:

```ts
// Why: processes killed by SIGKILL / OOM-kill skip stop() and leave behind
// o-<pid>-*.sock files. Sweep dead-pid sockets on startup so the userData
// directory does not accumulate orphans over the app's lifetime.
function sweepOrphanedRuntimeSockets(userDataPath: string, ownPid: number): void {
  let entries: string[]
  try {
    entries = readdirSync(userDataPath)
  } catch {
    return
  }
  for (const entry of entries) {
    const match = /^o-(\d+)-[A-Za-z0-9_-]+\.sock$/.exec(entry)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isFinite(pid) || pid === ownPid) continue
    try {
      process.kill(pid, 0)
      // Pid is alive — leave its socket alone. Another Orca instance owns it.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        try {
          rmSync(join(userDataPath, entry), { force: true })
        } catch {
          // Best-effort sweep; a permission error is fine to ignore.
        }
      }
    }
  }
}
```

**Constraints:** only sweep sockets with the exact `o-<digits>-<base64url-ish>.sock` shape; skip anything else. Never touch the current process's own pid even though the stricter `start()` flow already rmSync's it.

**Windows note:** this sweep is POSIX-only by construction — on Windows the transport is a named pipe (`\\.\pipe\orca-<pid>-<suffix>`) and named pipes don't leave filesystem entries in `userData`. No sweep needed.

**Socket-name invariant:** the sweep regex `^o-(\d+)-[A-Za-z0-9_-]+\.sock$` must stay in lockstep with `createRuntimeTransportMetadata()` in `runtime-rpc.ts`, which emits `o-${pid}-${endpointSuffix}.sock`. The cheap guard — and what this doc recommends — is a unit test that constructs a transport name via `createRuntimeTransportMetadata()` and asserts the sweep regex matches it; any future change to the socket-name shape trips the test. Longer-term, if the transport name grows more fields, the preferred answer is to export a shared constant or factory from `runtime-rpc.ts` that both the creator and the sweep regex consume, so the two can never drift by construction. Deferred here to keep the diff surgical.

## Deliberately not in scope

- **No CLI-side reader fallback.** Scanning for any live `o-*.sock` in `getCliStatus()` would require a per-socket sidecar metadata file (authToken, runtimeId) since today only one shared `orca-runtime.json` exists. That is a multi-instance-by-design change, not a bug fix. The fix above assumes the intended model is one Orca per userData.
- **No per-instance userData.** The env-var override `ORCA_USER_DATA_PATH` at `src/cli/runtime/metadata.js` already exists for power users who genuinely want parallel runtimes. No change.
- **No unlink of `endpoint.env` on stop.** The deferred-cleanup rationale at `src/main/agent-hooks/server.ts:1230-1237` (TOCTOU with a concurrent writer) is still correct under the single-instance lock: auto-update handoff still briefly has two processes sharing the file. Leaving the file unchanged on quit matches the existing fail-open policy and no user symptom motivates changing it.

## Testing strategy

### Unit tests (`src/main/runtime/runtime-metadata.test.ts`, extend)

- `clearRuntimeMetadataIfOwned` with matching `{pid, runtimeId}` → file removed.
- `clearRuntimeMetadataIfOwned` with mismatched pid → file retained.
- `clearRuntimeMetadataIfOwned` with mismatched runtimeId → file retained (simulates another instance having overwritten while we were still alive).
- `clearRuntimeMetadataIfOwned` with no file → no-op, no throw.

### Unit tests (new `src/main/runtime/runtime-socket-sweep.test.ts`)

Seed a temp userData directory with four entries so the three retention branches are distinct:

- `o-1-aaaa.sock` → own-pid-skipped branch (test passes `ownPid: 1`, so this is skipped via the `pid === ownPid` early-exit).
- `o-<process.pid>-bbbb.sock` → alive-but-not-own branch (`process.kill(pid, 0)` succeeds without `ESRCH` → retained).
- `o-99999999-cccc.sock` → dead-pid branch (`process.kill(pid, 0)` throws `ESRCH` → swept).
- `foo.sock` → non-matching-shape branch (regex miss → retained untouched).

Run sweep with `ownPid = 1` and assert: the `o-99999999-*.sock` file is gone; the other three remain. Using a synthetic `ownPid` (init pid `1`, effectively always alive on POSIX and never the test runner's own pid) means each of the three retained-entries covers a *distinct* code path, instead of collapsing "own-pid-skipped" and "alive-non-own-pid-retained" into the same observation.

### Helper extraction for the single-instance lock

Extract the lock acquisition into `src/main/startup/single-instance-lock.ts`:

```ts
export function acquireSingleInstanceLock(
  app: Electron.App,
  onSecondInstance: () => void
): boolean {
  if (!app.requestSingleInstanceLock()) {
    return false
  }
  app.on('second-instance', onSecondInstance)
  return true
}
```

`src/main/index.ts` wires it up inline after `configureDevUserDataPath(is.dev)`. Because the module's top-level cannot `return`, gate the file-writing init (`initDataPath` / `initStatsPath` / `initClaudeUsagePath` / `initCodexUsagePath` / `enableMainProcessGpuFeatures` / `installDevParentWatchdog` / `installDevParentDisconnectQuit`) behind an `if (hasSingleInstanceLock)` block and let the lifecycle handler registrations fire unconditionally — `app.quit()` prevents `whenReady` from ever dispatching, so `runtime` / `runtimeRpc` / `store` / `stats` stay `null` and every shutdown handler short-circuits via optional chaining:

```ts
const hasSingleInstanceLock = acquireSingleInstanceLock(app, focusExistingWindow)
if (!hasSingleInstanceLock) {
  if (is.dev) {
    console.log(
      '[single-instance] Another Orca instance is already running against this userData path — focusing existing window.'
    )
  }
  app.quit()
}

if (hasSingleInstanceLock) {
  installDevParentDisconnectQuit(is.dev)
  installDevParentWatchdog(is.dev)
  initDataPath()
  initStatsPath()
  initClaudeUsagePath()
  initCodexUsagePath()
  enableMainProcessGpuFeatures()
}
```

### Unit test of the helper (`src/main/startup/single-instance-lock.test.ts`)

With a fake `app` (stub `requestSingleInstanceLock()` + `on()`):

- When `requestSingleInstanceLock()` returns `false` → helper returns `false` and does NOT register `'second-instance'`.
- When it returns `true` → helper returns `true` and registers exactly one `'second-instance'` listener that invokes the callback.

### Integration assertion (narrow)

Do NOT try to assert "downstream service constructors were not invoked" by re-importing `src/main/index.ts`. Module-level side effects at lines 67-101 (dev watchdog, shell path hydration, userData path configuration) run before the lock check and would fire regardless, either failing the test or requiring heavy mocking.

Instead, the integration surface the fix cares about is already covered by: (a) the helper unit test above, and (b) the manual repro below. If deeper coverage is wanted later, the right move is to refactor `src/main/index.ts` so the `whenReady`-guarded setup is exported as a testable function — that is a separate refactor and deliberately out of scope for this fix.

### Manual repro (matches the issue's steps)

1. Launch packaged Orca. `cp ~/.config/orca/orca-runtime.json /tmp/before.json`.
2. Launch the AppImage / `.app` a second time. Verify the existing window receives focus (no new window appears) and `stat` shows `orca-runtime.json` mtime is unchanged.
3. Quit Orca. Verify `~/.config/orca/orca-runtime.json` is gone and `orca status --json` reports `runtime.state = 'not_running'` (not `'stale_bootstrap'`).
4. Kill a running Orca with `SIGKILL`. Verify that the next Orca launch removes the orphaned `o-<killed-pid>-*.sock` during `OrcaRuntimeRpcServer.start()`.

### Regression watch — auto-updater

`autoUpdater.quitAndInstall()` in `src/main/updater.ts:194` triggers the relaunch flow. The handoff is short (~1s) but non-atomic, so the design relies on the ownership guard to keep both interleavings safe:

- **Socket is removed before the new process binds.** The old process's `runtimeRpc.stop()` `rmSync`'s `o-<oldPid>-*.sock` as part of teardown. The new process then binds its own `o-<newPid>-*.sock`. The brief window of inconsistency is "metadata absent" + "no socket", never "metadata points at a live-but-wrong pid with a still-mounted old socket."
- **New writes before old clears (Ordering Y).** If the new process calls `writeRuntimeMetadata()` before the old process's `clearRuntimeMetadataIfOwned()` runs, the guard sees `current.pid !== ownedPid` (and `current.runtimeId !== ownedRuntimeId`) and suppresses the clear. The new metadata survives.
- **Old clears before new writes (Ordering X).** The old process finds its own pid + runtimeId in the file, clears it, and exits. The new process then writes its fresh metadata onto an empty slot. Same end state.
- **CLI behavior during the ~1s window.** `orca status` transitions `ready` → `not_running` (clean, not `stale_bootstrap`) → `starting` → `ready`. It never reports a wrong-pid reading, because the only two observable file states are "file for old pid" (pre-teardown) and "file for new pid" (post-write); the guard prevents a mixed state.

A future regression report that catches the transient `not_running` during an auto-update should be recognized as intended behavior.

### Cross-platform coverage

- **macOS / Linux / Windows:** single-instance lock path is identical (Electron handles the OS-level plumbing).
- **Windows:** named-pipe transport means no socket-sweep work; assert the sweep early-returns on `platform === 'win32'` (or simply does nothing because no matching entries exist).
- **Dev mode:** lock acquired against `orca-dev` userData; asserted by running `pnpm dev` twice and seeing the second exit immediately.

## Confidence

High. The diagnosis matches the reported symptom and filesystem evidence one-for-one; the fix adds only calls that Electron and the existing metadata module already expose. Second opinion from codex flagged the `configureDevUserDataPath` ordering constraint and the `clearRuntimeMetadataIfOwned` ownership guard, both incorporated above.

Concretely, the fix closes the reported data-integrity scenarios: double-click relaunch, `gtk-launch` relaunch, clean-quit of a second instance while the first stays open, and orphaned `o-<pid>-*.sock` files left by SIGKILL / OOM-kill. It deliberately leaves two narrow scenarios open: (1) the auto-updater handoff, where `orca status` may transiently report `not_running` for ~1s between the old process's clear and the new process's write — covered in the regression-watch section above; and (2) deliberate multi-instance launches via `ORCA_USER_DATA_PATH` / `ORCA_DEV_USER_DATA_PATH`, which remain an explicit power-user escape hatch with isolated userData per instance and are not in scope for this fix.
