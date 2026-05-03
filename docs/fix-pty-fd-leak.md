# Fix per-session PTY fd leak in the current daemon

## Status: resolved (2026-05-01)

**Native-side root cause confirmed and patched.** E2E validation under both Node and Electron ABIs: 50 spawn/kill cycles, ptmx count stays at baseline (0). Before the patch, the same harness reproduced a 1-fd-per-spawn linear leak (5 → 55 ptmx fds over 50 cycles).

## Root cause (actual)

The leak is a native-side off-by-one in `node-pty@1.1.0`'s `pty_posix_spawn` cleanup loop on macOS. In `src/unix/pty.cc`:

- **Allocation** (lines 697-701) walks `low_fds[0..2]`, allocating via `posix_openpt(O_RDWR)`. The loop `break`s at the first `low_fds[count] >= STDERR_FILENO`, so `count` holds the index of the last allocated slot (0, 1, or 2). These are decoy `/dev/ptmx` handles used as a workaround for a macOS pty race condition that ensures the real master fd lands above `STDERR_FILENO`.
- **Cleanup** (lines 781-783, buggy):
  ```c
  for (; count > 0; count--) {
    close(low_fds[count]);
  }
  ```
  When the typical case triggers (`break` at `count=0`, i.e. the very first `posix_openpt` returned an fd ≥ 2), the loop body never executes — `low_fds[0]` is never closed. Every spawn leaks one ptmx handle.

Upstream fixed this in commit [`af053f2`](https://github.com/microsoft/node-pty/commit/af053f2) (PR #882, 2026-01-28), but version 1.1.0 (pinned here) predates that fix.

**Applied fix:** minimal 3-line backport in `config/patches/node-pty@1.1.0.patch`:

```c
-  for (; count > 0; count--) {
-    close(low_fds[count]);
+  for (size_t i = 0; i <= count && i < 3; i++) {
+    close(low_fds[i]);
   }
```

The `i < 3` bound is an over-cautious defense against the pathological case where all three `posix_openpt` calls returned fds < `STDERR_FILENO` (loop exhausts to `count=3`, which would otherwise read `low_fds[3]` — UB in upstream's fix too, though unreachable in practice).

## Why the JS-side `destroy()` discipline (below) is still correct

The native patch alone closes the leak. But the JS-side changes landed in `pty-subprocess.ts`, `session.ts`, `terminal-host.ts`, `local-pty-provider.ts`, and `relay/pty-handler.ts` remain load-bearing for separate reasons:

1. **SIGHUP-to-recycled-pid hazard.** `UnixTerminal.destroy()` registers `_socket.once('close', () => this.kill('SIGHUP'))`. After the child is reaped, its pid can be recycled to an unrelated user process (Chrome tab, editor, etc.) before the socket close event fires. Neutralizing `proc.kill` on POSIX before `destroy()` prevents delivering SIGHUP to a stranger.
2. **`forceKill`/`signal` guard against recycled pid.** `process.kill(proc.pid, …)` after `onExit` targets a potentially-recycled pid. The internal `dead` guard converts these into no-ops.
3. **Daemon shutdown determinism.** `TerminalHost.dispose()` → `Session.forceKillAndDisposeSubprocess()` reaps stubborn children via SIGKILL and releases the master fd synchronously, bypassing the 5s `KILL_TIMEOUT_MS` fallback.
4. **Belt-and-suspenders fd release.** Calling `destroy()` on every teardown path remains the contract that will keep holding if the pinned node-pty is ever replaced or upgraded to a build without the bug.

## Original problem statement (for historical context)

## Problem

The current `daemon-v4` is leaking PTY master file descriptors (`ptmx`) at a rate roughly 20× the live session count. In a real reported case, the live v4 daemon was holding **269 `ptmx` fds for only 13 active terminals** — every closed terminal should have returned its `ptmx` to the OS, but the daemon keeps accumulating them until it hits macOS's `kern.tty.ptmx_max=511` cap and every new terminal (Orca or otherwise) fails with "cannot allocate any more pty devices."

This is a distinct bug from the orphaned-daemon issue handled in [auto-kill-old-daemons.md](./auto-kill-old-daemons.md):

| Bug | Fd leak unit | Lifetime | Fix surface |
|---|---|---|---|
| Orphaned daemons | Whole daemon process | Across app upgrades | `daemon-init.ts`, `daemon-pty-router.ts` |
| **This doc** | Per-PTY `ptmx` | Within any node-pty-hosting process | `pty-subprocess.ts` (daemon), `local-pty-provider.ts` (legacy), `relay/pty-handler.ts` (SSH) + wiring |

Both bugs compound each other (stale daemons × leaky sessions), but either one is sufficient to exhaust the cap in a few days of normal use. Fixing orphan daemons alone would only slow down the bleed — the PTY wrappers themselves must stop leaking.

The same missing `destroy()` call exists in all three node-pty-hosting code paths (daemon, legacy local provider, SSH relay), so the fix is scoped to all three.

### Root cause

The master ptmx fd is owned by a `tty.ReadStream` that node-pty stores on the `UnixTerminal` instance as `_socket` (see `node_modules/node-pty/lib/unixTerminal.js`). That socket wraps the fd via libuv. The fd only gets closed when the socket is destroyed, and the socket is only destroyed by one of:

1. `UnixTerminal.destroy()` — calls `_close()`, then `_socket.destroy()`, then `_writeStream.dispose()`.
2. The socket's own `'close'` / `'error'` event firing, which hits the `self._socket.on('close', ...)` wiring inside node-pty's constructor.

None of our current teardown paths reliably trigger either. Specifically:

1. **`forceKill` via raw `process.kill(pid, 'SIGKILL')`** (`pty-subprocess.ts:159-168`) kills the child but does nothing to the libuv socket on the parent side. The slave fd closing in the kernel does not, by itself, cause the parent's read-side socket to emit `'close'` on all platforms / node versions — and even when it does, it races GC.
2. **`dead = true` after a thrown native error** (`pty-subprocess.ts:127-157`) leaves the `_socket` fully alive. We just stop touching `proc`; the read stream keeps the fd.
3. **Session `dispose()` / `handleSubprocessExit`** (`session.ts:189-228`, `session.ts:250-271`) never call anything that reaches `_socket.destroy()`. They kill the child and move on.

So the fd leaks until the JS wrapper is GC'd and libuv finalizes the stream — which may be much later, or never, within the daemon's lifetime. Evidence from the reported case is consistent with this: 269 ptmx − 13 live ≈ 256 orphaned fds from terminals that were opened and closed during the daemon's lifetime, which matches a few days of create/kill churn at ~50-100 terminal ops/day.

node-pty already exposes the fix: `UnixTerminal.prototype.destroy` (unixTerminal.js:219) and `WindowsTerminal.prototype.destroy` (windowsTerminal.js:141). We just never call it.

## Goals

- After a PTY terminates (by any path — natural exit, kill, force-kill, native throw, disposal), the master fd is released to the OS on the same tick as teardown.
- The fix covers every code path in the repo that spawns `node-pty`: the daemon, the legacy local provider, and the SSH relay.
- Zero regressions to the `dead` flag pattern (`pty-subprocess.ts:119-122`) that prevents `Napi::Error` from killing the daemon.
- No renderer-visible change. Public IPC / RPC contracts are untouched.
- Measurable: a repeatable test harness spawns N PTYs, terminates them via each exit path, and asserts the fd count returns to baseline.

## Non-goals

- Fixing the orphaned-daemon issue. Handled in [auto-kill-old-daemons.md](./auto-kill-old-daemons.md).
- Killing daemon-side sessions when a worktree is deleted. Separate follow-up.
- Upgrading or replacing `node-pty`. We are calling node-pty's existing `destroy()` — no library change needed.
- Adding a generic "fd leak monitor" watchdog. Observability belongs in a separate effort (see Related work).

## Design decisions

### Call `node-pty`'s `destroy()` on every teardown path

The fix is exactly that. Each provider already wraps the raw `IPty` in its own small handle/struct. Add a single `dispose()` entry point on those wrappers whose body does:

```ts
try {
  ;(proc as unknown as { destroy?: () => void }).destroy?.()
} catch {
  /* swallow — already torn down, or native-side error we can't recover from */
}
```

That is the primary mechanism. `destroy()` is what drives `_close()` → `_socket.destroy()` → `_writeStream.dispose()` inside node-pty, which is what releases the master fd. Everything else the wrapper needs (idempotency, callback nulling, SIGKILL fallback for unresponsive children) is a local concern layered around that single call.

### Why not reinvent `destroy()`

An earlier draft of this design proposed a hand-rolled body: null callbacks + raw SIGKILL + `proc.kill()` in try/catch. That was wrong. None of those steps touch `_socket`, which is the thing holding the fd. The only reliable trigger is the close path node-pty already ships — `UnixTerminal.prototype.destroy` on POSIX, `WindowsTerminal.prototype.destroy` on ConPTY. Duplicating that logic in our wrappers would (a) not work on POSIX anyway because `_socket` is private and (b) drift from upstream on any future node-pty update. Forward to `destroy()`, layer idempotency and error-swallowing on top, stop.

### Shared handle contract

Each provider exposes a dispose entry point with the same semantics: idempotent, synchronous, throws never. The daemon already has a `SubprocessHandle` type that is the right place to hang it; the local provider and relay each have equivalent internal records (`ptyProcesses` / `ManagedPty`) and get a small helper function that wraps the same `destroy()` call plus their provider-specific bookkeeping (listener disposal, map cleanup).

```ts
// src/main/daemon/session.ts
export type SubprocessHandle = {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  forceKill(): void
  signal(sig: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
  /** Release the native PTY handle via node-pty's own destroy() path.
   *  Idempotent. Safe to call after exit. Called by Session on every teardown
   *  path (natural exit, kill, force-kill, native throw, session dispose). */
  dispose(): void
}
```

### Daemon: `pty-subprocess.ts`

Track a `disposed` flag. `dispose()`:

1. If already disposed, return.
2. Mark `disposed = true` and `dead = true`.
3. Null the JS-side `onDataCb` / `onExitCb` references so the wrapper stops fanning out anything after destroy.
4. **On POSIX only, neutralize `proc.kill` on this instance.** Replace it with a no-op before step 5. This closes the pid-recycle SIGHUP hazard described below. Windows is exempt because `WindowsTerminal.destroy` *is* a call to `kill()` — neutralizing it turns destroy() into a no-op and leaks the ConPTY agent.
5. Call `proc.destroy()` inside try/catch. On Unix this runs `_close()` → `_socket.destroy()` → `_writeStream.dispose()`; on Windows it defers to the ConPTY agent's close via `_deferNoArgs(_this.kill())` (`windowsTerminal.js:141-146`).

```ts
dispose(): void {
  if (disposed) return
  disposed = true
  dead = true
  onDataCb = null
  onExitCb = null
  // Why: node-pty's UnixTerminal.destroy() registers `_socket.once('close', () => this.kill('SIGHUP'))`
  // (unixTerminal.js:219-229). On the dispose-while-alive path (e.g. daemon shutdown
  // of an active session), SIGTERM has already been sent. The socket close fires
  // asynchronously; by then the child may have exited and its pid been recycled
  // to an unrelated process. Without this neutralization, SIGHUP can be delivered
  // to a Chrome tab, editor, or other user process — silent cross-app corruption.
  // `_socket.destroy()` still releases the fd; only the dangerous SIGHUP is removed.
  //
  // Platform guard: WindowsTerminal.destroy() implements the ConPTY close by
  // CALLING `this.kill()` via `_deferNoArgs` (windowsTerminal.js:141-146). If we
  // neutralize `kill` on Windows, destroy() becomes a no-op and the ConPTY
  // agent leaks. The SIGHUP hazard is POSIX-only, so the neutralization is too.
  if (process.platform !== 'win32') {
    ;(proc as unknown as { kill?: (sig?: string) => void }).kill = () => {}
  }
  try {
    ;(proc as unknown as { destroy?: () => void }).destroy?.()
  } catch {
    /* swallow — already torn down, or native-side error we can't recover from */
  }
}
```

`kill` neutralization lives on this `proc` instance only — the wrapper's exposed `kill()` / `forceKill()` entry points call `process.kill(proc.pid, sig)` directly (`pty-subprocess.ts:149-175`), which is unaffected. Callers that want to send SIGTERM/SIGKILL still can; what they can't do after dispose is have node-pty's internal close listener deliver an unexpected SIGHUP against a stale pid.

No extra SIGKILL is needed from `dispose()`: `forceKill` remains available as a separate entry point for the "we need the child gone now" case. Callers that want both (Session on timeout) call `forceKill()` then `dispose()`.

### Daemon: Session / TerminalHost wiring

`Session.dispose()` (`session.ts:189-228`) and `Session.handleSubprocessExit()` (`session.ts:250-271`) each call `this.subprocess.dispose()`:

- `handleSubprocessExit`: call it immediately after updating `_state = 'exited'` and before fan-out to `attachedClients`. try/catch around the call — a throwing dispose must not prevent exit-code delivery.
- `dispose()`: call it at the end, after `emulator.dispose()` and after the attached-client fanout.
- `forceDispose()` (`session.ts:319-347`): same as `dispose()`.

`subprocess.dispose()` is idempotent because `handleSubprocessExit` and the outer `dispose()` can both fire for the same session (manual kill → child exits → handleSubprocessExit runs → later Session.dispose runs).

`TerminalHost.dispose()` (`terminal-host.ts:215-240`) already kills every session. Replace the `session.kill()` call in the shutdown loop with a new `session.forceKillAndDisposeSubprocess()` method, so daemon shutdown reaps stubborn children (SIGKILL) AND releases the PTY master fd synchronously — without depending on the 5s `KILL_TIMEOUT_MS` eventually calling `forceDispose`:

```ts
for (const [, session] of this.sessions) {
  session.detachAllClients()
  session.forceKillAndDisposeSubprocess() // synchronous; bypasses the 5s timer
}
// Preserve existing post-loop cleanup: sessions.clear(), killedTombstones.clear(),
// and any cleanup callbacks fire unchanged after the loop. Only the per-session
// kill() → forceKillAndDisposeSubprocess() substitution is new.
```

**Why `forceKillAndDisposeSubprocess` instead of `kill() + disposeSubprocess()`.** Today's shutdown path is `session.kill()` (SIGTERM, start 5s timer) → if the child ignores SIGTERM, `forceDispose()` eventually fires and sends SIGKILL. That 5s fallback is load-bearing: shells with traps, hung compilers, and long-running processes with signal handlers routinely ignore SIGTERM. The earlier draft dropped `killTimer` during disposeSubprocess, which would close the fd but leave the child orphaned at the OS level — worse than today's behavior. `forceKillAndDisposeSubprocess` explicitly sends SIGKILL (via `subprocess.forceKill()`) before releasing the fd, so stubborn children are still reaped synchronously:

```ts
// Public: orderly-shutdown path. Force-kills the child (SIGKILL is not
// ignorable), then releases the PTY master fd synchronously. Used only by
// TerminalHost.dispose() — renderer reconnects cold after daemon exit.
forceKillAndDisposeSubprocess(): void {
  // Why: forceKill before the subprocess dispose. disposeSubprocess below
  // neutralizes node-pty's kill() on POSIX, which is what the internal SIGHUP
  // close listener would call. forceKill uses process.kill(pid, 'SIGKILL')
  // directly (pty-subprocess.ts:159-168) — unaffected by the neutralization,
  // because it does not go through proc.kill. SIGKILL is not ignorable; any
  // child that would have survived the 5s timer is reaped immediately.
  try {
    this.subprocess.forceKill()
  } catch {
    /* swallow — child may already be gone */
  }
  this.#teardownSubprocess()
}
```

`disposeSubprocess()` is a tight helper — it flips the session to the terminal state, cancels any pending timers, and forwards to the subprocess dispose. It deliberately does not fan out `onExit` to attached clients, because `TerminalHost.dispose()` is the orderly-shutdown path and the renderer will reconnect cold.

**Shared `#teardown` helper.** Both `Session.dispose()` and `Session.disposeSubprocess()` mutate the same state (`_disposed`, `_state`, `killTimer`, `shellReadyTimer`) and forward to `this.subprocess.dispose()`. Route them through a single private helper `#teardownSubprocess()` so the state transition is defined exactly once — two dispose paths that drift on which flag gets flipped would be a merge hazard (a future change to one that forgets the other silently drops exit events):

```ts
// Session — shared private helper, called by both public paths.
#teardownSubprocess(): void {
  if (this._disposed) return
  this._disposed = true
  // Note: `_state = 'exited'` is NOT set here — the outer caller (Session.dispose,
  // Session.forceDispose) is responsible for the state transition AFTER capturing
  // any invariants that depend on the pre-flip value. See the `wasTerminating`
  // capture in Session.dispose for the load-bearing example.
  if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null }
  if (this.shellReadyTimer) { clearTimeout(this.shellReadyTimer); this.shellReadyTimer = null }
  try {
    this.subprocess.dispose()
  } catch (err) {
    // Why: dispose() is documented never to throw, but if it does we must not
    // prevent callers from completing their own cleanup (fanout, map removal).
    console.warn('[Session] subprocess.dispose() threw:', err)
  }
}

// Public: orderly-shutdown path. Does NOT broadcast onExit to clients; the
// renderer reconnects cold after TerminalHost.dispose(). Sets _state = 'exited'
// after teardown because this path has no pre-flip invariants to preserve.
disposeSubprocess(): void {
  this.#teardownSubprocess()
  this._state = 'exited'
}

// Public: existing Session.dispose() — MUST capture `wasTerminating` BEFORE
// calling #teardownSubprocess, because the check depends on `_state !== 'exited'`
// being the PRE-flip value. Forgetting this check would orphan processes that
// ignored SIGTERM (the `_isTerminating && _state !== 'exited'` guard at
// session.ts:200 is the only path that calls `subprocess.forceKill()` in the
// dispose-while-terminating case).
dispose(): void {
  // Why: captured BEFORE the `_state = 'exited'` flip at line 230. This check
  // guards the "dispose while kill() was already in flight" case — if true,
  // the child hasn't reaped yet and we need to forceKill it here (the 5s
  // killTimer is also about to be cleared by #teardownSubprocess). Matches
  // the existing invariant at session.ts:200. Do not move this line below
  // #teardownSubprocess or the `_state = 'exited'` assignment.
  const wasTerminating = this._isTerminating && this._state !== 'exited'
  const clientsToNotify = wasTerminating ? this.attachedClients.slice() : []

  if (wasTerminating) {
    // Existing forceDispose semantics — child hasn't reaped yet, force it now.
    try { this.subprocess.forceKill() } catch { /* already dead */ }
    this._exitCode = -1
    this._isTerminating = false
  }

  this.#teardownSubprocess()
  this._state = 'exited'

  this.attachedClients = []
  this.preReadyStdinQueue = []
  this.postReadyFlushGate.clear()
  this.emulator.dispose()

  for (const client of clientsToNotify) {
    client.onExit(-1)
  }
}
```

Single source of truth for the state transition. If we ever need to add a new piece of tear-down state, one edit keeps both paths in sync. The asymmetry (`_state = 'exited'` lives in the public methods, not the helper) is deliberate: `dispose()` has a pre-flip invariant (`wasTerminating`) to preserve, `disposeSubprocess()` doesn't. Forcing both through a single helper that flipped `_state` would reintroduce the ordering bug.

**`forceDispose()` must also route through the helper.** `forceDispose` fires from the 5s `killTimer` when a SIGTERM'd child refused to exit (`session.ts:319-347`). This is the exact kill-timeout path this fd-leak fix targets — if `forceDispose` doesn't call `subprocess.dispose()`, the ptmx fd leaks on every force-kill. The current body flips `_disposed = true` directly at `session.ts:324`, which would short-circuit a later `Session.dispose()` call from `TerminalHost` tombstone cleanup at `#teardownSubprocess`'s `if (this._disposed) return` guard, silently skipping `subprocess.dispose()`.

```ts
// Private: fires from the 5s killTimer when SIGTERM was ignored.
// `_state === 'exited'` already short-circuits above; below that guard the
// session is still running, so the fd is still open. MUST release it.
private forceDispose(): void {
  if (this._state === 'exited') {
    return
  }
  // Why: unlike dispose(), forceDispose has no pre-flip invariants to capture.
  // The caller (killTimer) has no attached-client fanout obligation beyond
  // what the helper + the existing client loop below cover. Route the
  // subprocess tear-down through the shared helper so `proc.destroy()` runs
  // exactly once and `_disposed` is flipped in the same transition.
  try { this.subprocess.forceKill() } catch { /* already dead */ }
  this._exitCode = -1
  this._isTerminating = false

  this.#teardownSubprocess()  // ← sets _disposed = true, calls subprocess.dispose()
  this._state = 'exited'

  const clients = this.attachedClients
  this.attachedClients = []
  this.preReadyStdinQueue = []
  this.postReadyFlushGate.clear()
  this.emulator.dispose()

  for (const client of clients) {
    client.onExit(-1)
  }
}
```

Order matters. `forceKill()` must run BEFORE `#teardownSubprocess()` — the helper's `subprocess.dispose()` neutralizes `proc.kill` on POSIX, but `subprocess.forceKill()` uses `process.kill(proc.pid, 'SIGKILL')` directly and is unaffected by that neutralization. If we reorder, nothing changes functionally, but the explicit order documents the invariant.

After `session.forceKillAndDisposeSubprocess()`, the 5s `killTimer` started by any prior `kill()` is cleared, so `forceDispose` cannot fire against an already-disposed subprocess. Even if the timer somehow survived the clear, `_state` is now `'exited'` and `forceDispose`'s early-return guard (`session.ts:320`) would short-circuit it.

### LocalPtyProvider

`local-pty-provider.ts` stores each spawned `IPty` in a module-level `ptyProcesses` map and has two teardown sites: `shutdown(id)` (single PTY) and `killAll()` / `safeKillAndClean()` (bulk). Both currently call `proc.kill()` and delete the map entry.

Change: add a `destroyPtyProcess(proc)` helper. Same shape as `disposeManagedPty` in the relay: on POSIX, neutralize `proc.kill` before calling `destroy()` to close the same SIGHUP-to-recycled-pid hazard; on Windows, skip the neutralization because `WindowsTerminal.destroy` calls `kill()` internally. Invoke the helper at the end of `safeKillAndClean` (after listener disposal, after `proc.kill()`), at the end of `shutdown` (same spot), and in the natural-exit `onExit` path after `clearPtyState(id)`.

```ts
function destroyPtyProcess(proc: IPty): void {
  // Why: same SIGHUP-to-recycled-pid hazard as the daemon and relay paths.
  // UnixTerminal.destroy() registers `_socket.once('close', () => this.kill('SIGHUP'))`.
  // LocalPtyProvider's own kill() has already fired; if the close listener
  // delivers a trailing SIGHUP after pid recycling, it lands on a random user
  // process. Local machines recycle pids fast — regression risk is highest here.
  // Windows exempt: WindowsTerminal.destroy IS a kill() call via _deferNoArgs.
  if (process.platform !== 'win32') {
    ;(proc as unknown as { kill?: (sig?: string) => void }).kill = () => {}
  }
  try {
    ;(proc as unknown as { destroy?: () => void }).destroy?.()
  } catch {
    /* swallow — already torn down */
  }
}
```

The natural-exit `onExit` invocation is load-bearing: without it, a shell that exits cleanly (the common case) never releases its ptmx fd until the next GC. `onExit` is also the only path that runs without an external kill having been issued, so the neutralization is defensive against future reorderings — today `proc.kill` is a no-op after the child is reaped, but the kernel may still emit the close event.

### Relay: `relay/pty-handler.ts`

`PtyHandler` stores each `IPty` on a `ManagedPty` record. Teardown happens in five places:

- `shutdown(params)` — SIGTERM + 5s SIGKILL fallback, or SIGKILL immediately when `immediate === true`.
- The `onExit` wiring inside `wireAndStore` — deletes the map entry.
- `spawn()`'s stale-context path (`pty-handler.ts:144-154`) — client reconnected before the PTY response was delivered, so the PTY is orphaned and gets SIGTERM + 5s SIGKILL fallback.
- `dispose()` — loops every managed pty and shuts it down.
- `sendSignal()` — public entry point that forwards arbitrary signals; must keep working after dispose is queued.

Change (ordering matters):

1. **`onExit` wiring**: after the map-delete, call `disposeManagedPty(managed)`. This is the natural-exit path — the child has already exited and been reaped. Neutralizing `pty.kill` here is defensive: any trailing invocation from the socket close listener is no-op'd regardless of pid-recycle timing. The fd is released synchronously.
2. **`shutdown(params)` with `immediate === true`**: after `managed.pty.kill('SIGKILL')`, call `disposeManagedPty(managed)`. SIGKILL has already reaped the child.
3. **`shutdown(params)` graceful path (SIGTERM)**: do **not** call `destroy()` immediately after the SIGTERM send. The 5s `killTimer` and the natural `onExit` already cover fd release via step 1. Calling `destroy()` right after SIGTERM collapses the graceful-shutdown window and risks interrupting shell `EXIT` traps or cleanup hooks that run between SIGTERM and shell exit. If the `killTimer` fires (SIGKILL fallback), the SIGKILL reaps the child and `onExit` (step 1) calls `disposeManagedPty` on its own — **do not add a redundant call inside the killTimer closure**. The `disposed` guard makes a redundant call harmless but wiring it in both places is a merge hazard.
4. **`spawn()` stale-context killTimer**: this path (`pty-handler.ts:149-153`) already sends SIGTERM then SIGKILL at 5s if the PTY wasn't acked. The relevant teardown path is `onExit` (step 1), which now calls `disposeManagedPty`. No code change needed in the stale-context branch itself — the onExit wiring in `wireAndStore` runs for this PTY the same as for any other. Confirmed covered.
5. **`dispose()` loop**: call `disposeManagedPty` for each active managed pty AFTER `managed.pty.kill('SIGTERM')`. This is the relay-shutdown path — we accept that any in-flight shell cleanup is cut short because the relay process itself is exiting.

The common shape, extracted into a helper:

```ts
function disposeManagedPty(managed: ManagedPty): void {
  if (managed.disposed) return
  managed.disposed = true
  // Why: clear any pending 5s SIGKILL fallback timer. If graceful-shutdown
  // armed a killTimer and the child then exited cleanly (firing onExit →
  // disposeManagedPty), the timer would otherwise fire later and attempt
  // pty.kill('SIGKILL') on an already-disposed instance. The ptys.has(id)
  // guard inside the timer short-circuits today, but symmetry is clearer.
  if (managed.killTimer) {
    clearTimeout(managed.killTimer)
    managed.killTimer = undefined
  }
  // Why: same SIGHUP-to-recycled-pid hazard as the daemon fix — neutralize
  // node-pty's kill on the instance before calling destroy(). The relay
  // typically runs on Linux remote hosts where pid recycling is fast.
  // Windows exempt: WindowsTerminal.destroy calls kill() internally, so
  // neutralizing it turns destroy() into a no-op.
  if (process.platform !== 'win32') {
    ;(managed.pty as unknown as { kill?: (sig?: string) => void }).kill = () => {}
  }
  try {
    ;(managed.pty as unknown as { destroy?: () => void }).destroy?.()
  } catch {
    /* swallow */
  }
}
```

**`disposed` flag on `ManagedPty`.** The flag is new — add it to the `ManagedPty` type. Purpose: prevent `disposeManagedPty` from running twice (both `onExit` and `shutdown` can fire for the same PTY), and — more importantly — let `sendSignal`, `writeData`, and other pre-existing entry points short-circuit if the caller tries to use a disposed PTY:

```ts
private async sendSignal(params: Record<string, unknown>): Promise<void> {
  // ... existing signal validation ...
  const managed = this.ptys.get(id)
  if (!managed || managed.disposed) {
    throw new Error(`PTY "${id}" not found`)
  }
  managed.pty.kill(signal)  // ← on POSIX this is neutralized-to-no-op only
                            //   AFTER disposeManagedPty runs. The early return
                            //   above means we never reach this line post-dispose.
}
```

Without the `disposed` guard, a `sendSignal('SIGTERM')` call landing after `onExit` → `disposeManagedPty` has neutralized `managed.pty.kill` would silently succeed (return success, do nothing). The `disposed` check converts the silent failure into the existing "not found" error, which is what callers already handle.

The graceful-SIGTERM path of `shutdown` remains unchanged (SIGTERM + 5s killTimer that sends SIGKILL). Fd release on that path happens either via the `onExit` hook (step 1) when the shell exits cleanly, or via the killTimer → SIGKILL → `onExit` chain if SIGTERM was ignored. Under no circumstance does `shutdown`'s graceful branch synchronously call `destroy()`.

### Why not just replace `node-pty`

Tempting, and probably correct long-term. Out of scope here: node-pty's API surface is deeply woven into the daemon, LocalPtyProvider, and the relay. Swapping it is a multi-week effort with its own regression surface. This bug is a one-line miss against an API the library already ships — fix that first.

### Why not a daemon-level fd watchdog

A periodic "count my open fds, restart if over threshold" watchdog would mask the bug, not fix it. It also introduces the exact timer-based lifecycle the orphan-daemon design [explicitly rejected](./auto-kill-old-daemons.md) for the same reasons (cold-restore instead of warm-reattach, false positives against live work). Observability yes, auto-restart no.

## Interaction states

Because this fix sits below the IPC layer, the renderer sees no state changes. All user-visible interaction states are identical to today:

| Trigger | User-visible state | Behind the scenes (new) |
|---|---|---|
| Click "Close terminal" | Tab closes immediately | `terminal:kill` IPC → `Session.kill()` → `handleSubprocessExit` → `subprocess.dispose()` → `proc.destroy()` → fd released |
| Shell exits naturally (`exit` / Ctrl-D) | Tab shows exit code | `handleSubprocessExit` → `subprocess.dispose()` → `proc.destroy()` → fd released |
| Daemon is killed mid-session | Renderer reconnects cold on next app launch | On orderly shutdown: `TerminalHost.dispose()` loop → per-session `forceKillAndDisposeSubprocess()` — SIGKILL first (stubborn children reaped), then `proc.destroy()` releases the fd synchronously. Does not depend on the 5s `KILL_TIMEOUT_MS`. |
| Child hits `Napi::Error` race | Silent (today) | Silent (same) — next teardown trigger reaches `subprocess.dispose()`, which forwards to `proc.destroy()` regardless of `dead` |
| Session.kill hits `KILL_TIMEOUT_MS` | User sees "force-closed" log entry (unchanged) | `forceDispose` → `forceKill` + `subprocess.dispose()` → fd released |
| SSH worktree session closed | Tab closes immediately | Relay `PtyHandler.shutdown` → SIGTERM + `managed.pty.destroy()` on exit → fd released on remote host |

## Data flow

```
Renderer                 Main (IPC)                Daemon (TerminalHost)          node-pty
   │                         │                            │                          │
   │  terminal:kill          │                            │                          │
   ├────────────────────────▶│   RPC: kill(sessionId)     │                          │
   │                         ├───────────────────────────▶│  Session.kill()          │
   │                         │                            ├─ subprocess.kill() ─────▶│  (SIGTERM)
   │                         │                            │                          │
   │                         │                            │◀── onExit(code) ─────────│
   │                         │                            │  handleSubprocessExit    │
   │                         │                            │  ├─ state='exited'       │
   │                         │                            │  ├─ subprocess.dispose()─┼─▶ destroy() →
   │                         │                            │  │                       │   _close() +
   │                         │                            │  │                       │   _socket.destroy() +
   │                         │                            │  │                       │   _writeStream.dispose()
   │                         │                            │  │                       │   → ptmx fd released ✔
   │                         │                            │  └─ fanout onExit        │
   │                         │◀─── event: 'exit' ─────────│                          │
   │◀── terminal:exit ───────│                            │                          │
```

### Failure paths

**Natural exit.** Child dies, `proc` emits `onExit` → `handleSubprocessExit` → `subprocess.dispose()` → `proc.destroy()` → `_socket.destroy()` → fd released, same tick.

**Explicit kill (`Session.kill`).** SIGTERM → child exits → same path as above.

**Kill timeout.** Child ignores SIGTERM → `KILL_TIMEOUT_MS` elapses → `forceDispose` → `subprocess.forceKill()` (SIGKILL) + `subprocess.dispose()` (`proc.destroy()`). Fd released within 5s worst case.

**Native throw.** `proc.write/resize/kill` throws `Napi::Error` → `dead = true`. Session is wedged but still reachable. The next teardown trigger (user close, daemon shutdown, worktree close) reaches `subprocess.dispose()`, which forwards to `proc.destroy()`. The destroy() body itself is try/catch-wrapped — if the native side is already half-torn-down and throws, we swallow; the socket side still gets destroyed by any prior event.

**Daemon shutdown.** `TerminalHost.dispose()` iterates sessions and calls `session.forceKillAndDisposeSubprocess()` synchronously. The ordering is: SIGKILL (`subprocess.forceKill()` → `process.kill(pid, 'SIGKILL')`) → `subprocess.dispose()` → `proc.destroy()`. SIGKILL is not ignorable, so any child that would have survived the normal 5s `KILL_TIMEOUT_MS` SIGTERM window is reaped before the fd release. On POSIX, every `ptmx` fd is released before the daemon process exits. On Windows, `WindowsTerminal.destroy` defers via `_deferNoArgs` — dispose is enqueued but may not run synchronously; this is acceptable because ConPTY is not subject to the POSIX `ptmx` cap (see Risks).

**Local provider (non-daemon).** `LocalPtyProvider.shutdown(id)` / `killAll()` / natural `onExit` all route through the new `destroyPtyProcess(proc)` helper, same `proc.destroy()` call. Fd released symmetrically with the daemon path.

**Relay (SSH).** `PtyHandler.shutdown` and `PtyHandler.dispose` both call `managed.pty.destroy()` after the existing kill. On relay shutdown the loop is synchronous, so ptmx fds in the remote host's relay process are released before the relay exits.

## Architectural fit

```
┌─ Daemon (forked) ───────────────┐   ┌─ Main process ─────────────┐   ┌─ Relay (remote host) ────┐
│  TerminalHost                   │   │  LocalPtyProvider          │   │  PtyHandler              │
│     └─ Session                  │   │     └─ ptyProcesses map    │   │     └─ ManagedPty map    │
│         └─ SubprocessHandle     │   │         (proc.destroy ←NEW)│   │         (pty.destroy ←NEW)│
│             └─ dispose() ←NEW   │   │                            │   │                          │
│                 └─ proc.destroy()│   └────────────────────────────┘   └──────────────────────────┘
└─────────────────────────────────┘           │                                 │
              │                               └───────────┬─────────────────────┘
              └───────────────┐                           │
                              ▼                           ▼
                   ┌──────────────────────────────────────────────┐
                   │  node-pty destroy()                          │
                   │   → _close() → _socket.destroy() → fd freed  │
                   └──────────────────────────────────────────────┘
```

Three providers, one shared fix: forward the local dispose call to `node-pty.destroy()`. No new layer, no new dependency direction. Each provider already owns its handle lifecycle — we are filling a gap in three existing chains, not creating them.

## Implementation plan

### Files to change

| File | Change |
|---|---|
| `src/main/daemon/session.ts` | Add `dispose(): void` to `SubprocessHandle` type. Add `forceKillAndDisposeSubprocess()` + `disposeSubprocess()` public methods. Add private `#teardownSubprocess()` helper that does NOT flip `_state` (see `dispose` section). Call `subprocess.dispose()` from `handleSubprocessExit`, `dispose`, `forceDispose`. Preserve the `wasTerminating = this._isTerminating && this._state !== 'exited'` invariant by capturing it BEFORE any state flip in the refactored `dispose`. |
| `src/main/daemon/pty-subprocess.ts` | Implement `dispose()` on the returned handle. Idempotent. Nulls callbacks, sets `dead = true`, gates the `proc.kill = noop` neutralization on `process.platform !== 'win32'`, forwards to `(proc as unknown as { destroy?: () => void }).destroy?.()` in try/catch. |
| `src/main/daemon/terminal-host.ts` | In `dispose()`, call `session.forceKillAndDisposeSubprocess()` instead of `session.kill()`. Preserves the SIGKILL-fallback behavior without depending on the 5s timer. |
| `src/main/providers/local-pty-provider.ts` | Add `destroyPtyProcess(proc)` helper: gates `proc.kill = noop` neutralization on POSIX, then calls `proc.destroy()` in try/catch. Invoke from `safeKillAndClean`, `shutdown`, and the `onExit` path (after `clearPtyState`). |
| `src/relay/pty-handler.ts` | Add `disposed: boolean` field to `ManagedPty`. In `wireAndStore`'s `onExit` (after map delete) and in `dispose()` loop, call `disposeManagedPty(managed)`. In `shutdown` immediate-path (after SIGKILL), call `disposeManagedPty`. In the 5s killTimer SIGKILL fallback (graceful path and spawn stale-context path), also call `disposeManagedPty`. Do **not** call it in the graceful SIGTERM branch. Guard `sendSignal`, `writeData`, `resize`, `getCwd`, `getInitialCwd`, `clearBuffer`, `hasChildProcesses`, `getForegroundProcess`, `attach` with `managed.disposed` checks (treat disposed as "not found"). |
| `src/main/daemon/session.test.ts` | Add `dispose: vi.fn()` to `createMockSubprocess`. |
| `src/main/daemon/terminal-host.test.ts` | Add `dispose: vi.fn()` to `createMockSubprocess`. |
| `src/main/daemon/terminal-host-startup.test.ts` | Add `dispose: vi.fn()` to `mockSubprocess`. |
| `src/main/daemon/production-launcher.test.ts` | Add `dispose: vi.fn()` to `createMockSubprocess`. |
| `src/main/daemon/daemon-pty-provider.test.ts` | Add `dispose: vi.fn()` to `createMockSubprocess`. |
| `src/main/daemon/reattach-snapshot.test.ts` | Add `dispose: vi.fn()` to `createMockSubprocess`. |
| `src/main/daemon/__tests__/pty-fd-leak.test.ts` (new) | Integration test for the daemon path: spawn N sessions, tear them down via each path, assert fd count returns to baseline. |
| `src/main/providers/__tests__/local-pty-fd-leak.test.ts` (new) | Same test, targeting `LocalPtyProvider` directly. |
| `src/relay/__tests__/pty-fd-leak.test.ts` (new) | Same test, targeting `PtyHandler` directly. |

### Testing plan

The hard part of this fix is not the code — it's proving the leak is closed in all three providers. Two layers:

#### 1. Unit-level handle behaviour

Per provider, for each exit path (`kill`, `forceKill`, native throw simulated by calling `dispose` after an artificial dead state, natural exit), assert:

- `proc.destroy()` is called exactly once per PTY (spy on the mock `IPty`).
- Calling the provider's dispose a second time is a no-op (idempotency).
- After dispose, subsequent `write/resize/kill` are no-ops and do not throw.
- No `Napi::Error` surfaces from any follow-on method call.

#### 2. Integration-level fd count

One test file per provider (`src/main/daemon/__tests__/pty-fd-leak.test.ts`, `src/main/providers/__tests__/local-pty-fd-leak.test.ts`, `src/relay/__tests__/pty-fd-leak.test.ts`), same shape:

```
baseline = countPtmxFds(process.pid)
for i in 1..50:
  pty = provider.spawn(...)
  provider.shutdown(pty.id)   // or forceKill / dispose / let it exit naturally
  await exit event
after = countPtmxFds(process.pid)
assert after === baseline
```

Loop once per exit path per provider.

**Platform-specific `countPtmxFds` implementation:**

- **macOS:** `lsof -p <pid> -Ffn` → parse as (fd, name) pairs → count pairs whose fd is numeric (not `cwd`/`txt`/`rtd`) AND whose name is exactly `/dev/ptmx`. The `-Ffn` machine-readable mode emits one field per line prefixed with `f` (fd) or `n` (name); a naive `startsWith('n')` filter that doesn't cross-check the preceding `f` row false-matches on non-fd rows whose NAME happens to be `/dev/ptmx`. Never use `grep ptmx` unqualified — it false-matches on env vars and any path containing the substring.
- **Linux:** iterate `/proc/<pid>/fd/*`, `readlink` each entry, match against the regex `/^(\/dev\/ptmx$|\/dev\/pts\/ptmx$|anon_inode:\[?ptmx\]?$)/`. The master pty fd does not show as `/dev/ptmx` on modern Linux kernels — depending on the pty backend and kernel version, `readlink` returns `anon_inode:[ptmx]` (devpts backend on many distros) or `/dev/pts/ptmx`. A naive `grep /dev/ptmx` yields zero matches and the test passes vacuously — **zero regression coverage** instead of real coverage. CI runs on `ubuntu-latest`; this matters.
- **Windows:** skip entirely (ConPTY doesn't expose ptmx; rely on the unit-level `destroy()` spy).

**Mandatory `beforeAll` counter smoke.** Before the first assertion, spawn one real PTY, measure `countPtmxFds`, kill it, measure again, and assert `beforeSpawn < afterSpawn` and `afterKill <= beforeSpawn`. If either check fails, the counter itself is broken on this platform — skip the whole suite with a clear message (`skip('ptmx counter not functional on this platform')`). Otherwise, the fd-count assertions could go green on a broken counter and we'd think the fix landed when it didn't.

```ts
beforeAll(async () => {
  const baseline = countPtmxFds(process.pid)
  const probe = pty.spawn('/bin/sh', ['-c', 'sleep 30'], { /* ... */ })
  await new Promise((r) => setTimeout(r, 100))
  const withProbe = countPtmxFds(process.pid)
  probe.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 200))
  const afterKill = countPtmxFds(process.pid)
  if (!(withProbe > baseline) || !(afterKill <= baseline)) {
    // Why: if the counter can't even observe spawn/kill deltas on a known-good
    // PTY, it can't observe the leak we're trying to prove closed. Vacuously
    // passing assertions would give false confidence. Skip instead.
    return describe.skip('ptmx counter smoke failed; skipping fd-leak suite')
  }
})
```

These tests spawn 50 real subprocesses each and must be gated behind an env-var skip (not a vitest tag — vitest 4 doesn't ship built-in tag filtering in this repo's config). Use `describe.skipIf(!process.env.RUN_SLOW_TESTS)`. Every spawn inside the loop must be wrapped in try/finally that force-kills the child regardless of assertion outcome — otherwise a mid-loop failure leaks the remaining subprocesses into the test runner, corrupting the next suite's baseline.

#### 3. Manual verification

Reproduce the reported 269/13 case locally:
1. Start a fresh daemon.
2. Baseline: `lsof -p $(pgrep -f daemon-entry) | grep -c ptmx` → small (one per live session).
3. Churn: open and close 50 terminals via the UI.
4. Verify the count returns to baseline within seconds. Before the fix, it stays at ~50.
5. Repeat against a non-daemon worktree (LocalPtyProvider path) and against an SSH worktree (relay path).

### Rollout

No flag needed. The change is pure bug-fix with strictly smaller resource footprint. Ship with the orphan-daemon fix in the same release — they are complementary and together close the full leak story.

### Regression surface

| Regression | Mitigation |
|---|---|
| `dispose()` throws, breaking exit-code fanout to clients | Wrap every dispose call site in try/catch. `destroy()` call itself is also in try/catch inside the wrapper. |
| `proc.destroy()` is not present on an older/forked node-pty build | Optional chain: `(proc as unknown as { destroy?: () => void }).destroy?.()`. Current pinned version has it on both UnixTerminal and WindowsTerminal; tests assert it's called. |
| Double-dispose double-frees the native handle | Idempotency guard (`if (disposed) return`) at the top of dispose. node-pty's own `destroy()` is also safe to call twice — `_close()` is idempotent (it replaces `write`/`end` with no-ops and flips `_writable`/`_readable` to false the first time; the second call overwrites no-ops with no-ops). `_socket.destroy()` and `_writeStream.dispose()` are both idempotent per Node stream semantics. |
| `dead` flag pattern regresses, `Napi::Error` kills daemon | All existing `dead`-guarded methods stay exactly as-is. `dispose()` sets `dead = true` and then calls `destroy()`; it adds to the pattern, does not replace it. |
| Newly-nulled onData callback drops final data burst | Session already fans out synchronously in `handleSubprocessData` before exit. Nulling after exit is safe. |
| Neutralizing `proc.kill` on Windows turns `destroy()` into a no-op (ConPTY leak) | `WindowsTerminal.destroy` calls `kill()` via `_deferNoArgs` — we gate neutralization on `process.platform !== 'win32'`. Verified in `pty-subprocess.ts` and `local-pty-provider.ts` and `relay/pty-handler.ts` helpers. Test: mock `process.platform = 'win32'`; assert `proc.kill` is NOT replaced with noop; assert `destroy()` is still called. |
| Shared `#teardownSubprocess` helper flips `_state` before callers capture `wasTerminating`, orphaning stubborn children | Helper explicitly does NOT flip `_state`. Each public method (`dispose`, `disposeSubprocess`, `forceKillAndDisposeSubprocess`) owns its own `_state = 'exited'` line and captures any pre-flip invariants before calling the helper. Test: session with `_isTerminating=true`, `_state='running'` calls `dispose()`; assert `subprocess.forceKill()` is called before `subprocess.dispose()`. |
| `sendSignal` / `writeData` / `resize` silently no-op after relay `onExit` neutralized `managed.pty.kill` | Every public entry point on `PtyHandler` that touches a `ManagedPty` checks `managed.disposed` first and treats disposed as "not found" (existing error path). Converts silent failure to an explicit error callers already handle. |
| `TerminalHost.dispose()` drops 5s SIGKILL fallback for stubborn children | New `forceKillAndDisposeSubprocess` method explicitly sends SIGKILL via `subprocess.forceKill()` before releasing the fd. SIGKILL is not ignorable. Test: session whose child ignores SIGTERM; call `forceKillAndDisposeSubprocess`; assert child is reaped AND fd is released, both synchronously. |
| LocalPtyProvider delivers trailing SIGHUP to recycled pid | `destroyPtyProcess(proc)` mirrors the daemon and relay helpers: POSIX-guarded `proc.kill = noop` neutralization before `destroy()`. Covers natural-exit, `safeKillAndClean`, and `shutdown` paths. |

## Risks

| Risk | Severity | Why acceptable |
|---|---|---|
| `destroy()` doesn't actually release the fd | Low | We are literally calling node-pty's canonical close path (`_close()` → `_socket.destroy()` → `_writeStream.dispose()`). Only way this is ineffective is a node-pty bug or a version regression — and the integration fd-count tests catch both before merge. |
| Idempotent dispose hides a real double-free bug | Low | Idempotency only skips work; it does not suppress errors. |
| `TerminalHost.dispose()` synchronous loop blocks daemon shutdown | Low | `destroy()` on each PTY is a handful of syscalls; 50 sessions ≈ single-digit ms. |
| `destroy()` on Windows defers via `_deferNoArgs` | Low | ConPTY never hit the ptmx cap (it's a POSIX resource). Windows dispose is correctness-for-symmetry, not a load-bearing leak fix. |
| The real leak is elsewhere (e.g., an fd leak outside the PTY code path) | Low | Integration tests directly measure fd reclamation across a full spawn/kill lifecycle. If the fix works there, it addresses the observed symptom. |

## Related work (out of scope)

- **Orphaned legacy daemons**: [auto-kill-old-daemons.md](./auto-kill-old-daemons.md) — complementary fix targeting daemon-level lifecycle.
- **Worktree-delete does not kill sessions**: separate follow-up. Today, deleting a worktree from the sidebar leaves its PTY sessions live in the daemon, which is a different leak vector.
- **Daemon fd observability**: expose an IPC `daemon:stats` handler so Orca can surface fd count in a debug view. Would let us detect regressions in production rather than waiting for user reports.
- **Replace `node-pty`**: out of scope; see "Why not just replace node-pty" above.
