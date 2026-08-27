# Reading the Windows process table

Orca needs three things from the Windows process table: who a PID's parent is
(descendant walks and teardown identity), what a process is running (agent
recognition), and how much memory/CPU it uses (Resource Manager).

Node cannot answer the first one without native code. That is why seven
independent readers existed, each forking `powershell.exe` to run
`Get-CimInstance Win32_Process`, with a `wmic` fallback that Windows 11 24H2 has
since removed.

## Use the native snapshot

`src/main/windows/windows-process-table.ts` is the only module that may read the
table. It wraps a Toolhelp32 snapshot from `@vscode/windows-process-tree`.

```ts
import { readWindowsProcessTable, readWindowsProcessTableFresh } from '../windows/windows-process-table'
```

- `readWindowsProcessTable()` — shared TTL cache. Use for anything periodic.
- `readWindowsProcessTableFresh()` — a snapshot that starts after the call. Use
  for teardown identity, where a cached row can predate the exit it is being
  asked about.

Both **reject** when the table cannot be read. Do not convert that into an empty
array. An empty table is a claim that nothing is running, and callers act on
that claim by declaring a tree dead or a shell childless. "Unavailable" has to
stay distinguishable from "empty" — collapsing the two is how a PTY tree
survived its own teardown (#9045).

Measured on Windows 11 with 1050 processes (p50 / p95):

| | p50 | p95 |
| --- | --- | --- |
| pid + ppid + name | 15.9 ms | 17.5 ms |
| + memory + command line | 30.6 ms | 33.7 ms |
| `Get-CimInstance` via PowerShell | 706 ms | 723 ms |

Those CIM numbers are from a 1050-process host. The scan scales with process
count: on a 1486-process Windows SSH host it measured **1.36 s** and produced
**4.8 MiB** of JSON, against the fallback's 3 s and 8 MiB limits. Both limits
match the pre-#15749 reader, so relay hosts are at parity rather than newly at
risk — but the headroom is roughly 2x on time and 1.7x on bytes, not the ~4x the
706 ms figure implies. On overflow the output is truncated, the JSON fails to
parse, and the read rejects, so a busy host loses the table rather than
receiving a wrong one.

## When a read wedges

The vendored reader pushes every callback onto a module-global queue and drains
that queue only when the request holding its `requestInProgress` latch
completes. If a Toolhelp32 snapshot never comes back — an EDR hook, a restricted
token, a worker that dies — the latch is stuck for the life of the process and
every later call parks another closure in that queue.

Two guards, and they work together:

- a **3 s deadline** on each read, so a caller gets a rejection instead of a
  promise that never settles;
- a **sticky wedge**: once a read misses its deadline and has not called back,
  the module refuses every further read until that read's callback fires.

The wedge used to be a 30 s cooldown that let one probe through per window. That
bounded the *rate* of new callbacks but not the total: a permanently wedged
reader retained one more closure every 30 s for as long as the app ran, and each
probe also blocked its caller for the full 3 s deadline first. Gating on the
outstanding read instead bounds retention at exactly one callback, and gives up
nothing on recovery — a probe queued behind the latch could never have observed
recovery anyway, whereas the stuck callback firing is the drain itself. On the
relay's bare addon, which has no queue of its own, it is also what keeps Orca
from re-entering `CreateToolhelp32Snapshot` while a call is still running.

That last part is not just tidiness. The addon runs each read as a
`Napi::AsyncWorker`, so a wedged read holds a libuv threadpool slot for good. On
the relay the JS queue is not there to absorb the retries, so one probe per
window would have pinned all four default threads inside ~2 minutes — hanging
every async `fs` and DNS call in that process, not only the process table.

A wedge does **not** engage the PowerShell fallback; see the next section for
why only absence does.

## The relay has no binding, and falls back

Relay deployment installs only `node-pty` and `@parcel/watcher` on the remote
host (`RELAY_NATIVE_DEPS` in `src/main/ssh/ssh-relay-deploy.ts`), so a Windows
machine used as an SSH host has no `@vscode/windows-process-tree` at all. It is
not added there on purpose. Both ways of installing it fail, and both were
checked on a real Windows SSH host with 1486 processes:

**Installing it normally rebuilds from source, and that build fails.** The
tarball carries a `binding.gyp`, so npm runs `node-gyp rebuild` regardless of
what is already compiled inside it. On a host that *already had* MSVC Build
Tools 2022 installed, that build still failed:

```
error MSB8040: Spectre-mitigated libraries are required for this project.
```

That is the requirement the `binding.gyp` hunk of our patch deletes, and the
patch cannot reach a remote host — pnpm patches do not cross SSH. Relay deploy
would then break outright rather than degrade: `installNativeDeps` throws on
failure, and the toolchain-skip retry is gated to Linux.

**Skipping the build and using the shipped binary returns a truncated table.**
Contrary to what this file used to claim, the published 0.8.0 tarball *does*
contain `build/Release/windows_process_tree.node` — an MSVC build directory that
looks accidentally published (`.obj` and `.tlog` files ship with it). It is
N-API, so it loads on any modern Node. But it predates our patch and still has
the `process_count < 1024` cap, so on that 1486-process host:

```
LOADED OK
rows=1024
selfPid=21964 present=false
```

Exactly 1024 rows, with the querying process itself among the missing. The
self-presence guard rejects that, so the fallback engages anyway — but only on
hosts busy enough to cross the cap. That is worse than no binding at all: it
works on a quiet machine and fails silently under load, which is precisely the
shape of bug that survives testing.

So the constraint is not that no binary exists to ship. It is that the only
binary available to ship is the broken one, and building the good one needs a
toolchain the remote does not have.

Instead, `windows-process-table.ts` falls back to
`readWindowsProcessRowsWithCim` (`windows-process-table-cim-scan.ts`), the
`Get-CimInstance` scan this module replaced. The gate is deliberately narrow:

- it engages **only** when the module cannot be required, never when a loaded
  module fails, wedges, or returns an unreadable table — a present-but-failing
  reader must not silently start forking a shell at the caller's poll rate;
- a fallback that also fails still rejects, so "unavailable" never degrades into
  "nothing is running";
- the scan applies the same self-presence guard as the native path.

`src/main/ssh/relay-native-dependency-coverage.test.ts` asserts that every
native addon reachable from the relay entry is either installed on relay hosts
or listed there with the reason its absence is safe. That test exists because
#15749 shipped this gap: the relay tests injected a fake module through
`__setWindowsProcessTreeLoaderForTests`, so nothing exercised the real require.

## Shipping the native reader to a relay anyway

The scan is the floor, not the destination: it costs ~1.4 s and a `powershell.exe`
where the addon costs ~57 ms. Release builds therefore compile the addon and ship
it as an optional relay artifact.

`config/scripts/build-windows-process-tree-relay-addon.mjs` builds it from the
source pnpm has already patched, on a Windows runner, and refuses to run if
any patch hunk is missing — the Spectre hunk fails loudly, the 1024-process
hunk fails *silently*, and the relative gyp path dies at configure on Windows.
The source is checked rather than the install trusted. It also reads the PE
machine field of the output, because a cross-build that quietly emitted host
arch would ship a binary the target cannot load.

Windows arm64 cross-compiles from the x64 runner — verified on real hardware,
producing `IMAGE_FILE_MACHINE_ARM64` (0xaa64) against x64's 0x8664. It needs the
optional *MSVC v143 ARM64 build tools* component; without it node-gyp fails with
`MSB8020`, which is why the addon build runs before the long packaging step.
`ORCA_REQUIRE_RELAY_NATIVE_ADDONS` is a per-arch list so a future arch can be
added best-effort before it is promoted to required.

`windows-process-table.ts` binds the bare addon directly rather than the package
wrapper. That wrapper adds only a queue over `getProcessList`, and that queue is
the wedge described above — it latches a module-global `requestInProgress` with
no try/catch. This module already holds a single-flight and a deadline, so going
straight to the addon drops the duplicate.

The artifact is optional in `RELAY_ARTIFACTS`: hashed when present, so a relay
carrying it never shares an immutable directory with one that does not, and
never probed, because requiring a file only a Windows build machine can produce
would make a correct relay read as MISSING and redeploy forever. A relay built
on any other OS keeps using the scan.

## Why the package is patched

`config/patches/@vscode__windows-process-tree@0.8.0.patch` carries three hunks.

1. **Spectre mitigation.** The upstream `binding.gyp` requires Spectre-mitigated
   libraries, which Orca's Windows build agents do not install. `node-pty` is
   patched the same way for the same reason.
2. **The 1024-process cap.** `GetRawProcessList` stopped after 1024 entries.
   Measured on a real host with 1051 processes, the module returned exactly
   1024 and the querying process was itself among the 27 missing. A truncated
   snapshot silently hides the descendants a teardown is trying to reap — the
   exact failure the native path exists to remove.
3. **Absolute `node-addon-api` gyp path.** `require('node-addon-api').targets`
   is cwd-relative. node-gyp on Windows evaluates it from the pnpm store
   realpath, then loads the relative path from the `node_modules` symlink, so
   `node_addon_api.gyp` resolves outside the repo and hourly Windows builds
   die at configure. `node-pty` is patched the same way for the same reason.

The typings claim `commandLine` is truncated at 512 characters. Measured, it is
not: the longest observed on a real host was 26,059.

## Packaging

The addon is Windows-only, so it follows the same contract as
`windows-native-registry` (asserted by
`config/scripts/package-electron-runtime-contract.test.mjs`):

- an `optionalDependency`, so a macOS/Linux install tolerates its absence;
- **not** in `pnpm.onlyBuiltDependencies` — pnpm installs optional dependencies
  on every host, and macOS/Linux must never run `node-gyp` for it;
- listed in the win32 branch of `rebuild-native-deps.mjs` and
  `ensure-native-runtime.mjs`;
- copied into the packaged `node_modules` for win32 only.

## What the snapshot does not provide

`CreationDate` (process start time) has no equivalent. Anything using a start
time to prove a PID has not been recycled — daemon identity, managed-hook
ownership, and CPU accounting in the memory collector — still reads it through
its own query. Those callers are not migrated.

Committed private bytes have no equivalent either, and the one memory value the
snapshot does carry is unusable for the sizes Orca now sees: `process.cc` stores
`pmc.WorkingSetSize` into a `DWORD`, so anything above 4 GB wraps. That is the
second reason `windows-process-resource-collector.ts` still runs its own
`Get-CimInstance` sweep — it needs `PageFileUsage` (commit) and the CPU-time
counters in the same pass. Migrating it to the native table would cost both.

Start time is a proxy for identity, not identity. The durable answer for the
process trees Orca itself spawns is an inherited handle: a job object names the
tree Orca created, so no start-time comparison is needed. Those readers should
be resolved that way rather than by adding a start time to this module.

Do not adopt `getProcessCpuUsage()` from the package. It takes both CPU samples
inside one call with a blocking `Sleep(1000)` in the middle, which would hold a
libuv threadpool slot for a full second out of the Resource Manager's two-second
poll.

## Owning a PTY's process tree

`src/main/windows/windows-pty-job.ts` is the counterpart to reading the table:
it answers "is this tree mine, and how do I kill it?" with a handle instead of
an inference.

node-pty is patched (`config/patches/node-pty@1.1.0.patch`) to create a job
object per ConPTY and assign the shell to it under `CREATE_SUSPENDED`, before
the shell can spawn anything. Assigning after the fact leaves a window in which
a fast child escapes the job.

- `terminatePtyJob(proc)` — one `TerminateJobObject` call for the whole tree.
- `listPtyJobProcessIds(proc)` — the live pids under a tree that is still
  tracked, including children that detached from the console.

Measured on Windows 11 against a shell whose grandchild was spawned `detached`:
job membership was `[shell, grandchild]` and one call killed both. Neither a
parent-pid walk nor `GetConsoleProcessList` sees that grandchild — it leaves
the console and reparents, which is what left `claude.exe`/`node.exe`/`cmd.exe`
holding worktree directories open (#9045, #10475, #10897).

The per-PTY job deliberately does **not** set
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Measured on Windows 11: with that flag,
releasing the handle when the shell exits also kills whatever the user left
running, so typing `exit` in a pane reaped a `start /b` server that used to
survive. The job exists to make an *explicit* teardown exact, not to redefine
what a clean exit means.

Reaping a dead daemon's shells (#9195, #10415) is therefore a **second, nested
job**, not this one. The terminal daemon assigns itself to a kill-on-close job
at startup (`assignHostProcessToKillOnCloseJob`); children inherit membership,
so every pty is covered and the per-PTY jobs nest inside it. Its handle is
released only when the daemon process dies, so a crashed daemon reaps its tree
without changing what a clean shell exit means.

The split is the point. One job answers "kill exactly this pane's tree, now";
the other answers "do not strand anything if the host dies". Trying to get both
from one job is what reaped users' backgrounded work on a clean `exit`.

It belongs to the daemon and never to the app: an app-main crash must still
leave sessions alive, which `.github/workflows/win-crash-survival-e2e.yml`
asserts. The app spawns the daemon `detached` and is itself in no job, so
nothing is inherited across that boundary.

The consequence is that a PTY hosted by the app rather than the daemon gets a
per-PTY job but no crash reaping. That is deliberate — the alternative is a
kill-on-close job on the app, which is exactly what the crash-survival
guarantee forbids.

Once the shell exits, node-pty drops its handle record and closes the job, so a
terminated tree reports `null` rather than `[]`. Null means *unverifiable* in
the sense of [`ssh-execution-boundary.md`](./ssh-execution-boundary.md) — no job
support, not a ConPTY, or no longer tracked. It is never evidence that
processes died.

Both functions report `unavailable` / `null` rather than a false success when a
pty has no job — an outer job without `JOB_OBJECT_LIMIT_BREAKAWAY_OK` (some EDR
and container hosts) can refuse the assignment, and a pty started before this
build has none. Callers must fall back, not conclude the tree is gone. That
conflation is the original bug.

### Known limitation: the baton table is not synchronised

node-pty keeps its per-terminal handles in a plain `std::vector` and erases from
it on a detached exit thread, while `get_pty_baton` is called from the main JS
thread. That race predates this change — `PtyResize`, `PtyClear` and `PtyKill`
all read the table the same way — but `terminatePtyJob` adds an instance of it:
the exit thread can close `hJob` between the lookup and `TerminateJobObject`.

Losing that race normally just returns `FALSE`, which surfaces as `unavailable`
and falls back. The case that would not be benign is a recycled `HANDLE` value,
where the call could reach a different job in the same process. Fixing it
properly means synchronising node-pty's handle table rather than adding a lock
around one accessor, so it is deliberately left alone here.

### The patch must actually be compiled

node-pty prefers its upstream prebuild and only builds from source when
`npm_config_build_from_source` is set or no prebuild exists for the platform.
The Windows prebuild does **not** contain this patch, so a plain `pnpm install`
on Windows yields a node-pty without the job-object exports — and
`terminatePtyJob` then reports `unavailable` on every call, which is
indistinguishable from a correctly degraded build.

Packaging is unaffected: `rebuild-native-deps.mjs` rebuilds node-pty from source
for Electron and restores the ConPTY runtime files that a bare `node-gyp
rebuild` skips. The gap is the **node-runtime test environment**, which is why
the Windows CI job rebuilds from source before running the win32 suites.

`isPtyJobOwnershipAvailable()` exists for exactly this: the win32 suite asserts
it is true before asserting anything else, so an unpatched binary fails loudly
instead of passing every case vacuously. That guard is what caught this.

`requiresPatchedNodePtySourceBuild()` in `ensure-native-runtime.mjs` still
exempts win32, on the premise that the patch is Unix-only. That premise is now
false, but lifting the exemption also needs `pnpm rebuild` to force a source
build — otherwise the assertion fires and the remedy does not fix it. Left as a
follow-up rather than changed blind.
