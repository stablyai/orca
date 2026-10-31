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

## Cause

The immediate failure is below the renderer: native asynchronous writes stop
completing, and later keystrokes accumulate behind the first pending write.
New terminals can also block on asynchronous working-directory checks.

A second affected daemon (2026-10-30, Node 24.21.0, libuv 1.52.1, 77 sessions,
two days up) was read with a brief `lldb` attach that only read memory:

- The libuv pool queue held 15 `uv__fs_work` items, all four workers were idle
  (`idle_threads == 4`), and the loop's completion queue was empty. The loop's
  async wakeup was intact: its `EVFILT_USER` knote was registered and
  `wq_async.pending` was 0. Work was never picked up; completion delivery was fine.
- The pool condition variable read `L = U = 0xfd79d800`, `S = 0xfd79d402`.
  Three workers waited at generations `0xfd79d6..d8`; the fourth waited at
  `0x7d79d800`, exactly `0x80000000` behind.

This is the Darwin psynch defect tracked in
[libuv#5280](https://github.com/libuv/libuv/issues/5280): a worker that stays
parked while its siblings complete 2^23 waits (0x100 per wait) falls half the
32-bit sequence range behind. The kernel then turns every signal into a prepost,
`U` catches up with `L`, and `pthread_cond_signal` returns in userspace without
a syscall. Nothing wakes the workers again. Timers and sockets do not use the
pool, so the daemon keeps answering RPCs.

## Prevention

On macOS the daemon holds every pool worker once every 60 seconds
(`threadpool-waiter-refresh.ts`). It posts one blocking read per worker on a
private FIFO and writes the bytes that release them 20 ms later. A worker holding
one read cannot take another, so the reads occupy distinct workers. Every parked
worker wakes and parks again at the current generation. Aging to the boundary
inside one interval would need about 140,000 pool operations per second. A round
is skipped while the previous one is unfinished, so a stalled pool gets no extra
work. The cost is one 20 ms pause of pool work per minute.

This prevents the stall. It cannot recover a pool that is already past the
boundary, because signals no longer reach the kernel. That daemon still needs the
restart review below. Upstream libuv PR 5351 bounds the worker wait natively.
Orca shipped a patched runtime with that change in #29133 and reverted it in #33688.

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
sessions or start terminals. A notice directs the user to the existing Manage
Sessions restart review, which requires confirmation before ending processes.

The new unary RPC is optional: old daemons return `unsupported`; lost contact or
an invalid response is `unverifiable`. Neither proves a stall. An affected old
daemon needs a deliberate restart onto a build with the probe before automatic
detection is available. Updating only the client cannot add instrumentation to
its already running daemon.

## Coverage and gaps

The experimental gate covers stalled/completing work, recovery, deduplication,
bounded timers/requests, old-peer compatibility, disconnected peers, notice
behavior, visibility gating, and unmount cleanup. The production probe also
identified this incident in the affected live daemon.

Local/daemon macOS evidence is covered. The probe is platform-independent, but
physical Linux, Windows, WSL and SSH deployments remain gaps. The notice describes
only this computer's current daemon. Paired web clients explicitly decline local
daemon inspection; remote/legacy daemon notices and hidden-sidebar surfacing are
not covered.

The refresh has unit tests for its round, skip and platform rules. Two manual
checks on macOS 26.2 arm64 cover the mechanism:

- An `lldb` read of an idle Node 24.22.1 process showed all four workers' wait
  generations move to the current value after one refresh round. A unit test
  checks that pool work posted during a round waits for the release.
- A pthread model of the pool, aged with 1 ns timed waits on the pool mutex
  (the method in libuv PR 5351), stalled with 0/4 jobs done after 2^23 + 4,096
  steps. Holding one job per worker for 1 ms every 1M steps let all four complete.

Serial `fs.promises.stat` on stock Node 24.22.1 with four workers stalled
naturally after 40,262,072 operations (21 minutes). The trigger is intermittent:
20M serial stats on two workers and 31M cycles of the libuv#5280 pthread repro
completed.
