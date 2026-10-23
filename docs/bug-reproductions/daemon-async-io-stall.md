# Terminal daemon asynchronous I/O stall

Observed on macOS arm64 on 2026-10-15. The installed app was
`1.4.227-hourly.202610150643`; the preserved v45 daemon was
`1.4.225-adhoc.20261012205540`, running Node 24.21.0 and libuv 1.52.1.

## What was proved

- The affected daemon answered authenticated control RPCs and its existing
  `ptySpawnHealth` probe. It owned 213 running sessions.
- Input sent through the CLI and directly through the daemon's `write` RPC did
  not appear in a selected terminal. Its native `CustomWriteStream` retained
  141 queued chunks / 1,250 bytes, with no retry timer. The shell-ready gate
  was open, and the native handle was neither dead nor marked I/O-failed.
- A synchronous write to that same nonblocking master fd immediately appeared
  in the agent's input. The diagnostic text was removed without submitting it.
  Resizing also reached the real terminal, and output was still received.
- Independent asynchronous filesystem stat and crypto requests did not complete
  while timers and socket RPCs continued working. Process samples showed all
  four libuv workers idle. This is evidence of stalled asynchronous work or
  completion delivery, **not proof of thread-pool saturation**.
- The production `DaemonAsyncIoProbe`, evaluated in that affected daemon,
  returned `stalled` at 5,000.8 ms. The debugger was closed afterwards.

## Recurrence and preserved daemon owners

On 2026-10-23 a preserved v50 macOS daemon (Node 24.21.0/libuv 1.52.1)
with 155 sessions again accepted control RPCs and output while input and new
terminal creation stalled. All four workers slept with queued work. The existing
probe logged `async-io-stalled`; interrupting the verified worker waits restored
input without replacing PTYs or agents, and the user confirmed recovery.
A working Claude terminal belonged to a different, older daemon. Agent type did
not identify which asynchronous worker pool was affected.

The desktop health check previously inspected only the current spawn adapter.
It now checks every already-adopted local daemon generation concurrently through
the same optional RPC, without listing sessions or opening connections. Any
identity-verified stalled owner can raise the existing restart-review notice,
even when another peer is healthy, unsupported or unreachable. A healthy snapshot of all supported owners clears the notice; known unsupported
old peers cannot pin the warning after a supported owner recovers. An unreachable
owner still prevents a healthy verdict. Removed adapters contribute no evidence;
new adapters, changed endpoint identities and provider replacement cannot inherit
an earlier owner's health. Unsupported and unverifiable results remain explicit.

## Cause and remaining investigation

The immediate failure is below the renderer: native asynchronous writes stop
completing, and later keystrokes accumulate behind the first pending write.
New terminals can also block on asynchronous working-directory checks.

Subsequent native witnesses and an ordinary sequential-job workload reproduced
a Darwin worker condition-generation half-range failure. The packaged-runtime
fix and detailed root-cause evidence are tracked in
[Orca #29133](https://github.com/stablyai/orca/pull/29133). The exact sequence of
Orca job producers is still unproved. Increasing the thread pool, replaying queued input, replacing
the writer with synchronous calls, or restarting healthy daemons is not a
validated prevention fix.

An older build remained alive intentionally: bundle freshness must not terminate
existing terminal processes. This explains why an app update did not replace
this daemon; it does not explain what first stopped its asynchronous work.

## Isolated symptom reproduction

On macOS/Linux, with dependencies prepared for the Node runtime:

```sh
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/ensure-native-runtime.mjs --runtime=node
ORCA_BACKGROUND_LAUNCH=1 UV_THREADPOOL_SIZE=1 node config/scripts/repro-daemon-async-io-stall.mjs
```

The script owns an isolated real PTY and blocks its one filesystem worker with a
FIFO open. It proves that native spawn/exit still passes while asynchronous input
and a working-directory stat stop completing, synchronous input still arrives,
and the production detector reports `stalled`. Releasing the FIFO delivers queued
input and restores `healthy`. It has a 15-second watchdog and never connects to
the user's daemon or sessions. This passed on macOS arm64 (Node 24.20.0), with
detection at 5,000.8 ms.

This reproduces the symptoms by fault injection, **not the original trigger**:
the incident's workers were idle, whereas this reproduction deliberately blocks
a worker. The asynchronous completion boundary is the shared failure surface.

## Detection and recovery contract

`terminal-daemon.async-io-progress`: a responding daemon whose asynchronous work
does not complete must not be represented as fully healthy solely because it
can start and exit a native shell. Detection must never infer process exit,
replay user input, or restart a daemon automatically.

The daemon probes an asynchronous stat of its own executable. Completion,
including completion with an errno, proves progress. A five-second deadline
reports a stall; the original operation stays owned until it actually completes.
Concurrent requests share it, so polling a permanently stalled daemon never
adds another filesystem request. Successful checks are cached for 30 seconds.
The daemon logs transitions as `async-io-stalled` and `async-io-recovered`.

The desktop checks every 30 seconds while the sidebar is mounted and the document
is visible, plus on focus/visibility changes. Checks coalesce and never enumerate
sessions or start terminals. The notice reviews only the affected owner's live
terminals before asking for destructive confirmation. Confirmation carries the
owner's protocol, PID, start time and launch nonce, plus every reviewed session
ID and incarnation. The daemon rechecks stalled state and the exact inventory,
refuses in-flight terminal creation, and closes admission before ending sessions.
An older owner is retired without restarting a healthy current owner. Current
owner replacement waits for its endpoint to be proven dead under the shared
restart barrier. Unknown replies, changed inventory and failed disposal never
fall back to a generic restart.

The new unary RPC is optional: old daemons return `unsupported`; lost contact or
an invalid response is `unverifiable`. Neither proves a stall. An affected old
daemon needs a deliberate restart onto a build with the probe before automatic
detection is available. Updating only the client cannot add instrumentation to
its already running daemon. Owner-targeted recovery is a separate optional
capability: a health-capable older daemon may still lack it. The notice explicitly
declines recovery in that case, and for a degraded current owner whose fallback
terminals cannot be included safely. Updating the client cannot retrofit the
new recovery RPC into an already running daemon.

## Coverage and gaps

The experimental gate covers stalled/completing work, recovery, deduplication,
bounded timers/requests, old-peer compatibility, disconnected peers, notice
behavior, visibility gating, and unmount cleanup. The production probe also
identified this incident in the affected live daemon. Isolated real-socket tests
exercise changed daemon/session incarnations, new sessions after review, recovered
health, exact-inventory shutdown and failed native disposal. Hidden Electron CDP
checks exercised the rendered review, cancel, confirmation, refusal and unsupported
states using simulated health/recovery responses; no user daemon was restarted.

Local/daemon macOS evidence is covered. The probe is platform-independent, but
physical Linux, Windows, WSL and SSH deployments remain gaps. The notice describes
only this computer's already-adopted daemons. Paired web clients explicitly decline local
daemon inspection; remote daemon notices and hidden-sidebar surfacing are
not covered. Older peers without the optional probe remain unsupported; the
runtime prevention fix is tracked separately in #29133.
