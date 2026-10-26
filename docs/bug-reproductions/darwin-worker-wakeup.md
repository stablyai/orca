# macOS terminal daemon worker wakeup stall

On 2026-10-15, a long-running packaged macOS daemon accepted RPC traffic and PTY
output but stopped delivering terminal input or creating terminals. Its Node
24.21.0/libuv 1.52.1 event loop remained responsive. All four worker threads were
idle in `__psynch_cvwait`, with 38 queued jobs and no completed work waiting for
the loop. Submitting one asynchronous stat grew the queue to 39 without a callback.
This distinguishes the incident from a busy or saturated worker pool.

A read-only native snapshot found these pthread condition generations:

```text
L = U = 0x953f6000
S     = 0x953f5c02
worker wait L: 0x153f6000, 0x953f6000, 0x953f5f00, 0x953f5e00
```

The oldest waiter was exactly `0x80000000` behind the current generation. This
matches the psynch half-range failure discussed in
[libuv #5280](https://github.com/libuv/libuv/issues/5280). Kernel waiter ordering
can turn wake signals into preposts; once the signal generation U catches L,
subsequent signals can return in userspace while workers remain asleep.

## Recurrence on 2026-10-23

A preserved v50 daemon running the unpatched Node 24.21.0/libuv 1.52.1
runtime stopped accepting input with 155 sessions. Authenticated control requests
still answered in 2–3 ms and terminal output continued; new terminal creation
timed out after 30 seconds. Asynchronous stat, directory and crypto callbacks
stalled, while all four workers slept in `__psynch_cvwait`, the global work queue
was nonempty and the completion queue was empty. The existing detector logged
`async-io-stalled`. A working Claude terminal belonged to a different, older
daemon, so the apparent Codex/Claude distinction was a daemon ownership difference.

A one-off native diagnostic interrupted all four verified workers while holding
their pool mutex. Queued work drained, fresh stats completed in about 1 ms, and
input resumed with the same PTY incarnation and agent processes. The user
confirmed recovery. Inspector access was then closed. This validates recovery
without restarting agents, but private-memory access and signal injection are
not production recovery mechanisms; bounded worker waits are the runtime fix.

## Reproduction and limits

The [upstream candidate](https://github.com/libuv/libuv/pull/5351) includes a
manual witness using production libuv workers and their real queue. It parks one
worker, advances the condition through 8,388,605 timed waits on the **same mutex**,
enrolls three fresh workers, and submits four jobs. It changes no private pthread
counters and does not occupy the worker pool with blocking filesystem requests.

| Build                          | Jobs | Callbacks | Queue    | Idle workers |
| ------------------------------ | ---- | --------- | -------- | ------------ |
| Unpatched, half-range boundary | 0    | 0         | Nonempty | 4            |
| Patched, same aging witness    | 4    | 4         | Empty    | 4            |
| Short control, either build    | 4    | 4         | Empty    | 4            |

The unpatched witness produced L = U = 2147483904, S = 2147482882, and oldest
wait L = 256: exactly the same half-range relationship as the live daemon.
The patched witness refreshed the old wait during aging and completed normally.
A separate idle-generation regression fails on unpatched libuv and passes with
the patch; nineteen focused pool, cancellation, fork and condition tests pass.

The controlled witness proves the native mechanism; the later sequential-job
reproduction below establishes an ordinary scheduling path to it. The precise
Orca job-producer sequence is still unproven. Stress runs with up to 60 million jobs, stop/continue cycles,
signals and PTY churn did not independently reproduce that enrollment sequence.
The earlier PTY fault injection established symptoms only.

## Ordinary-workload reproduction

A later run on the exact unpatched packaged Node also reproduced the failure
without condition aging or fault injection: queue one empty native job, and queue
its successor from the completion callback. Four workers service one outstanding
job. An initial run stalled after 11,032,951 completed jobs and hung in worker
cleanup on normal exit. A second instrumented run started with a successful real
PTY echo and stalled after 11,886,884 completed jobs:

```text
L = 3043043584; oldest worker wait L = 895559936
L - oldest wait L = 2147483648 = 0x80000000
four idle workers; one queued native job
```

Four fresh async stats and a PTY write produced zero stat callbacks and no PTY
echo after 15 seconds; six jobs remained queued and U caught L. One worker had
stayed parked while millions of sequential jobs ran through the others. This
provides an ordinary scheduling path to the exact live-daemon signature. An
otherwise similar 30-million-job run completed, so the scheduling is intermittent.
The patched runtime completed all 30 million jobs, a fresh filesystem request
and real PTY echo. This still does not identify the exact sequence of Orca's own
job producers.

The repository now includes a portable-to-both-macOS-architectures N-API workload
and PTY oracle with no private pthread fields. Run it after the normal check:

```sh
ORCA_BACKGROUND_LAUNCH=1 ORCA_DARWIN_WORKER_STRESS=1 node config/scripts/verify-darwin-terminal-node.mjs
```

The workload runs 30 million sequential native jobs and requires PTY echo before
and after. After three seconds without progress, it allows forty seconds for
the thirty-second worker timeout and scheduling margin, requiring all four fresh
stat callbacks, a new PTY echo and resumed native work. It kills only its own disposable test
process if libuv cleanup is stranded. This probabilistic stress is opt-in; the
idle-refresh regression remains the regular CI oracle.

## Runtime mitigation

Only the private Darwin worker wait changes: it uses a 30-second relative timed
condition wait, retaining the existing queue predicate and Darwin error workaround.
Workers still wake immediately when signaled. An idle timeout rechecks queued
work and refreshes the wait generation, allowing recovery from lost wakeups.
The default four-worker pool adds at most eight timeout wakes per minute; the
regression also caps generation advancement to reject an accidental wake loop.
Public condition variables and other platforms are unchanged.

`config/scripts/build-darwin-terminal-node.mjs` builds the pinned official Node
source with this patch. The recipe now follows Node 24.22.1: its source archive
matches the official SHA-256 manifest, the patch applies with zero fuzz, and the
reviewed patched worker source is byte-identical to the Node 24.21.0 recipe. The recipe pins the source archive hash, reviewed patched
source hash, architecture and minimum OS. Cache receipts verify the resulting
executable bytes and fingerprint the build scripts, so changes to build logic
invalidate cached binaries. A Node pin change fails until the recipe is reviewed.
This preserves the existing signed
helper layout and stable host copy rather than changing its launch or permissions.

Run the shipping-runtime check on each macOS architecture:

```sh
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/verify-darwin-terminal-node.mjs
```

It builds the runtime, checks real PTY input and filesystem/DNS/crypto operations,
observes all four idle worker generations refresh, bounds their advancement, and
checks fresh asynchronous work. It inspects only its own test process. The Node 24.21.0 recipe passed on Apple silicon (x64 under Rosetta) and on
physical ARM and Intel CI ([run](https://github.com/stablyai/orca/actions/runs/38795005777)).
On 2026-10-23, the repository-built Node 24.22.1 arm64 runtime also passed:

```json
{
  "node": "v24.22.1",
  "uv": "1.52.1",
  "arch": "arm64",
  "fsDnsCrypto": "passed",
  "ptyInput": "passed",
  "idleWaitRefresh": "passed"
}
```

The official unpatched 24.22.1 runtime passed the same initial PTY and I/O checks,
then failed the idle-generation `advances > 0n` assertion. This supplies a current-pin
red/green regression. ARM CI qualification passed on PR commit `6f006d865193` in
[run 39922624279](https://github.com/stablyai/orca/actions/runs/39922624279);
Intel qualification was still running at review time. The cold
build also exposed multi-minute synchronous source cleanup; the cache lease is
now released after atomic publication and before cleanup, so a blocked heartbeat
cannot let a waiting builder steal the completed producer's lock. Cold source compilation is
substantial and is cached separately from packaging retries.

## Coverage and remaining risks

The packaged macOS terminal daemon receives this runtime, including local folder
workspaces and worktrees, and clients attached to that daemon. Existing daemons
keep their executable until deliberately restarted. The detection/restart prompt
is tracked separately in [Orca #29087](https://github.com/stablyai/orca/pull/29087).
No automatic restart or queued-input replay is part of this patch.

Linux/Windows and WSL are unaffected by the Darwin-only change. Standalone/SSH
server runtimes and the development Electron fallback do not receive this patch.
Mobile/relay clients benefit only when their execution host uses the patched
helper. An isolated Developer ID signed copy of the installed helper, with the
repository-built runtime substituted, served a PTY under hardened runtime. Its
protocol 45 required a matching smoke-test handshake; the original patch checkout used 46. A
repeat on October 23 with Node 24.22.1 passed strict signature verification,
real PTY input, filesystem/DNS/crypto and all four idle worker refreshes under
hardened runtime. This disposable copy used the installed helper's native
dependencies and an untimestamped Developer ID signature; it does not establish
notarization or qualification of a complete current package. A complete package
build, launchd/TCC attribution, older macOS releases, battery
impact and extended soak remain verification gaps. Do not infer remote process
death from missing callbacks or loss of contact. The experimental reliability gate records these
limits; an upstream merge and a Node release can eventually replace this backport.
