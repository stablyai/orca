# Headless Serve to Desktop Activation Design

## Problem

A packaged `orca serve` process uses the normal user-data profile and owns Electron's
single-instance lock. After the desktop process exits, that headless owner can keep the runtime
reachable while no desktop window exists. Current activation paths then fail in opposite ways:

- `orca open` returns as soon as any runtime answers, so it never asks macOS, Windows, or Linux to
  reveal a desktop window.
- Finder, Dock, or a second application launch reaches the normal `second-instance` callback. The
  callback opens a BrowserWindow inside the serve process even though serve skipped the desktop
  PTY startup contract and published window id `0` as the authoritative graph owner.

The unsupported transition can make the renderer reconnect through the in-process local PTY
provider instead of the surviving daemon. Persisted panes then appear missing and provider resume
commands may start replacement or duplicate agents.

## Safety invariants

1. One process remains the owner of the user-data profile, runtime metadata, hook endpoint, and
   single-instance lock throughout activation.
2. A serve process may open a desktop window only after it has adopted the persistent daemon PTY
   provider. If that provider cannot be established, activation fails closed and no renderer is
   created.
3. The headless graph sentinel transfers authority to the first real BrowserWindow before that
   renderer publishes its graph. After a windowless gap, the next window checkpoints live bindings
   before reclaiming authority; concurrently attached windows cannot steal it.
4. Activation never restarts the runtime RPC server, daemon, or agent processes.
5. A CLI `open` command succeeds only after a desktop window is reported available. Runtime
   reachability alone is insufficient.
6. Repeated activation requests during startup coalesce into one deferred attempt; blocked
   activation never becomes a latent request that opens unexpectedly later.
7. Remote-paired CLI clients do not launch a desktop application on the client machine.

## Rejected alternatives

### Let serve bypass the single-instance lock

Two Electron processes would share the same profile and race `orca-runtime.json`, agent-hook
endpoint files, Chromium profile state, and daemon bindings. The newest writer could leave stale
metadata when it exits. This recreates the ownership ambiguity that the lock prevents.

### Open the window but keep serve on LocalPtyProvider

This is the observed failure. Existing daemon session ids are absent from the local provider, so
renderer reattach can treat live agents as expired and issue replacement resume commands.

### Always promote even after daemon startup failure

If serve has already spawned local PTYs, the first renderer load's local orphan sweep can terminate
them. The safe response is an explicit blocked status and no BrowserWindow.

### Terminate serve and start a new desktop process

That requires a cross-process lock, runtime metadata, hook endpoint, daemon checkpoint, and CLI
parent handoff protocol. In-place promotion has one owner and can preserve the already-connected
daemon adapter, so it has a smaller interruption surface.

## Design

### 1. Shared startup services

Run the existing daemon PTY provider and agent-hook startup barrier for both desktop and serve
modes. Serve waits for the local-PTY barrier before it registers headless PTY IPC or reports ready.
This ensures any session created or adopted by serve uses the same persistent provider that the
desktop renderer will later use.

The runtime's terminal-side-effect callback is installed in both modes, but desktop-only bell,
command, link, and mode scanners remain disabled until a real renderer graph is ready. They are
disabled again when that graph disappears, so a long-lived pure headless process retains its
existing output cost.

### 2. Serve activation gate

A small process-local state machine owns `initializing`, `ready`, and `blocked`:

- activation while `initializing` records one pending request;
- entering `ready` runs that request once;
- entering `blocked` drops it and reports a diagnostic;
- activation while `ready` runs the existing focus-or-open policy;
- activation while `blocked` never calls `openMainWindow`.

Serve enters `ready` only when the local provider is no longer the in-process
`LocalPtyProvider`, headless IPC is registered, the runtime graph is published, and RPC startup has
completed. A daemon failure leaves serve functional as a headless fallback but marks desktop
activation `blocked`.

Both Electron `second-instance` and macOS `activate` events route through this gate. Normal desktop
startup uses the same gate in the ready state.

### 3. Graph authority transfer

Use a named `HEADLESS_RUNTIME_WINDOW_ID` sentinel. When `attachWindow(realId)` sees that sentinel,
the runtime enters the existing renderer-reloading state, advances the graph epoch, preserves live
PTY state, and transfers authority to `realId`. The renderer can then publish normally. A second
real window remains non-authoritative.

### 4. Desktop status contract and CLI open

`status.get` reports a backward-compatible desktop status:

- `available`: a real BrowserWindow owns the runtime graph;
- `openable`: activation can safely create or reveal a window;
- `initializing`: serve is still establishing the persistent provider;
- `blocked`: serve cannot safely promote.

Local `orca open` always launches/activates the installed application, even if runtime RPC is
already reachable, then polls until status becomes `available`. It returns a specific blocked error
instead of recommending `open -n`. Remote-paired clients keep their current no-local-launch
behavior.

## Verification

### Unit and contract tests

- activation gate queues once, drains once, and blocks without invoking open;
- runtime transfers authority from the headless sentinel to one real window and enters reloading;
- live local and SSH bindings are persisted before first promotion and later windowless reattach,
  while ordinary desktop background creation keeps its existing opt-in persistence behavior;
- desktop-only output scanners stay disabled until a real renderer graph is ready;
- status distinguishes headless, openable, blocked, and available states;
- CLI open activates a reachable headless runtime, waits for `available`, handles blocked state,
  focuses an already-running desktop, and never launches for remote pairing;
- source wiring proves serve starts and awaits the persistent provider before headless PTY
  registration and does not retain the old direct-open path.

### Isolated Electron lifecycle smoke

Using a disposable user-data directory:

1. launch built Electron in serve mode;
2. add a disposable repository and create a terminal through runtime RPC;
3. start a long-running command and capture runtime id, daemon session id, and provider process
   evidence;
4. launch the same app normally against the same profile;
5. assert the original serve process creates the only desktop window;
6. assert runtime id and PTY id stay unchanged and no replacement PTY appears;
7. send input after promotion and observe output from the same session.

The smoke must never use the user's installed profile or current agent sessions.

## Scope

This change fixes lifecycle ownership and safe desktop activation. Resource Manager false-positive
cleanup is handled independently by #8459 / PR #8467. LAN reachability of a server intentionally
bound to loopback remains outside this change.
