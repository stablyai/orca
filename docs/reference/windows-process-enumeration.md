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
import {
  readWindowsProcessIdentityTable,
  readWindowsProcessIdentityTableFresh,
  readWindowsProcessTable,
  readWindowsProcessTableFresh
} from '../windows/windows-process-table'
```

Each pair is a shared TTL cache plus a `Fresh` variant that starts its scan
after the call. Use `Fresh` for teardown identity, where a cached row can
predate the exit it is being asked about, and the cached one for anything
periodic.

All four **reject** when the table cannot be read. Do not convert that into an
empty array. An empty table is a claim that nothing is running, and callers act
on that claim by declaring a tree dead or a shell childless. "Unavailable" has
to stay distinguishable from "empty" — collapsing the two is how a PTY tree
survived its own teardown (#9045).

## Two flag sets: ask for a command line only if you read one

Neither flag is a wider column on the same query. Each is a separate
per-process syscall sequence, and they are not equally expensive to the EDR
watching:

- `CommandLine` (`process_commandline.cc`) —
  `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`, then
  `NtQueryInformationProcess(ProcessCommandLineInformation)` twice: once to size
  the buffer, once to fill it. The kernel builds the string, so no address space
  is opened or read. It used to walk the target's PEB with three chained
  `ReadProcessMemory` calls; the patched addon no longer contains that primitive.
- `Memory` (`process.cc`) — retired. It took a **second** `OpenProcess`, and that
  one carried `PROCESS_VM_READ`, which it acquired and never used.

Measured here (541 processes, 405 openable), per detailed scan, before → after
dropping `Memory`: `OpenProcess` 1082 → 541. That halving is all the `Memory`
drop bought on its own — both handles carried `PROCESS_VM_READ` at the time, so
it moved the PEB traffic not at all. Replacing the PEB walk with the kernel
query is what took `PROCESS_VM_READ` and `ReadProcessMemory` out of the addon
altogether; the two changes compose, and neither substitutes for the other.

So be precise about what these two flag sets buy now. A detailed scan is one
`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` per process and no memory
access at all. What the split buys on top of that is the handle itself: an
identity scan opens nothing.

So the module exposes two snapshots, and the row types differ so a cheap caller
cannot read what its flag set did not pay for:

| reader                                     | row type                     | flags                       | per-process handles |
| ------------------------------------------ | ---------------------------- | --------------------------- | ------------------- |
| `readWindowsProcessIdentityTable[Fresh]()` | `WindowsProcessIdentityRow`  | `None \| CreationTime`      | none                |
| `readWindowsProcessTable[Fresh]()`         | `WindowsProcessRow`          | `+ CommandLine`             | one `OpenProcess`   |

`Memory` is requested by neither. Nothing reads a working set off this table —
`windows-process-resource-collector.ts` runs its own sweep because it needs
commit and CPU counters in the same pass, and the addon stores `WorkingSetSize`
into a `DWORD` so anything above 4 GB wraps anyway.

Measured on Windows 11 with 492 processes (p50 / p95):

|                                  | p50     | p95     |
| -------------------------------- | ------- | ------- |
| identity (pid + ppid + name)     | 6.3 ms  | 7.0 ms  |
| detailed (+ command line)        | 12.3 ms | 13.4 ms |
| _retired_ (+ memory)             | 13.1 ms | 14.1 ms |
| `Get-CimInstance` via PowerShell | 706 ms  | 723 ms  |

There are exactly **two** caches, never one per caller. The fan-out this module
exists to prevent is one scan per _caller_, and each reader still serves every
caller wanting its flag set, so a 32-wide teardown still collapses into one scan
of each. A third cache would need a third flag set, not a third caller.

### Only one native read may be in flight, ever

This is the price of having two flag sets, and it is not optional.

The npm wrapper **coalesces rather than queues**. `getRawProcessList` pushes the
callback onto one list and calls the addon only when no request is in progress,
so a second concurrent caller's `flags` are **discarded** and it is handed the
first caller's rows. Measured against the real addon: issue identity first, both
callers get the same array, 0 of 541 rows carry a command line. A detailed read
that overlaps an identity read therefore returns a table with **every command
line empty**, and agent recognition reads that as "no agent" — silently, and
only under concurrency.

Nothing else in this module prevents that. Each snapshot cache single-flights
only within itself (`inFlight` is a closure per reader), and the wedge set
latches only *after* a read misses its 3 s deadline, so through the healthy
~12 ms of a scan neither excludes the other. Overlap is the normal state rather
than an edge case: other panes keep polling detailed at 750 ms while a teardown
takes identity snapshots, and `codex-structured-turn-processes.ts` issues fresh
detailed scans on turn stop.

`nativeReadGate` serializes every native read across both flag sets. It is also
what makes the relay's bare addon safe: `adaptAddon` has no queue at all, and
two simultaneous `CreateToolhelp32Snapshot` calls are the crash the vendor's
queue exists to prevent. Every link settles — a wedged read still rejects on its
deadline — so a waiter is never stranded; it re-checks the wedge and rejects.

Because only one native call is ever outstanding, the wedge gate and the 3 s
deadline stay **shared** and retention stays bounded at exactly one callback,
not one per reader. Read ids are module-global and monotonic, so a late callback
can only clear its own wedge.

`resetNativeReaderState` **chains** onto the gate rather than replacing it. A
replacement would let a waiter still holding the old chain run beside a read
queued on the new one; every link settles within the deadline, so chaining costs
a bounded wait and keeps the exclusion whole. That path is test-only, which is
exactly why it matters — it would otherwise hand a suite two concurrent calls
into its own mock, the condition these tests exist to detect.

### Testing this module: assert a positive property, on the right mock

Three defects have now shipped in this file's tests, all the same shape — a case
that passed for a reason other than the one it claimed to check:

1. A loader that built a **fresh mock per call**, so the coalescing it was meant
   to reproduce could never happen.
2. An identity-side assertion of only `!('command' in row)`, which a correctly
   flagged read and a coalesced one satisfy equally, so the test would go green
   on the very regression it guards.
3. A concurrency assertion placed on the **coalescing** mock, whose own
   `requestInProgress` latch means it can never report more than one call in
   flight — so it held whether or not this module excluded anything, and passed
   against a read gate that had genuinely lost exclusion.

The third arrived in the fix for the first two, which is the point: this is not a
mistake you make once.

So: assert what each flag set **did** get, not only what it lacks, and put those
assertions in the helper both orderings run through, or the reverse order keeps
the blind spot. The identity set is checked on `creationTimeMs` because that is
the field it exists to carry. Keep both that check and the flags-array check —
they catch **different** failures and neither is redundant. The flags array
catches a read served another flag set's rows (the coalescing bug); the
positional `creationTimeMs` check catches field shaping — identity dropping
`CreationTime` from its flags, or `toIdentityRow` failing to forward it — which
no flags assertion would notice.

And pick the mock to match the claim. The coalescing mock models the npm
wrapper's queue semantics and is the only place to assert those. Concurrency has
to be measured against the bare-addon mock, which has no queue and so makes
re-entry observable.

With no native binding there is only one scan to run and it is the 1.4 s
PowerShell one, so the identity view rides the detailed snapshot — projected
through `toIdentityRow`, so an identity row carries no command line on any host.

### Which callers need which

| caller                                        | reads              | flag set |
| --------------------------------------------- | ------------------ | -------- |
| `windows-agent-foreground-process.ts`         | `command` (agent recognition) | detailed |
| `local-workspace-platform-port-scanner.ts`    | `command` (port attribution)  | detailed |
| `codex-structured-turn-processes.ts`          | `command` (turn-process identity) | detailed |
| `structured-tui-process-identity.ts`          | `command` (child match)       | detailed |
| `windows-pty-root-identity.ts`                | `pid` / `ppid` only           | identity |
| `agent-session-process-identity-probe.ts`     | `creationTimeMs` only         | identity |
| `relay/windows-port-scan.ts`                  | `name` (port owner label)     | detailed |

`windows-port-scan.ts` is the one mismatch in the table: it reads only `pid` and
`name`, which the identity set answers, but it calls the detailed reader. On a
host with a live pane that costs nothing extra — the detailed snapshot is
already cached — and on a headless relay it pays for a command line no caller
reads. Left as-is deliberately, because moving it to identity would trade that
for a second scan whenever a pane is polling; revisit if the relay ever scans
ports without one.

The per-pane foreground tracker is the hot one (750 ms / 2 s cadence) and it
genuinely needs the command line, so the repeating per-process `OpenProcess` is
not something the split removes. What the split removes is that handle from
teardown identity and from the owner probe, which now open nothing.

### `creationTimeMs` does not exist on any shipped build

Nothing in the repo supplies a `CreationTime` flag. The package enum is
`None`/`Memory`/`CommandLine`, `process_worker.cc` emits no `creationTimeMs`,
the vendored patch adds none, and `adaptAddon`'s `PROCESS_DATA_FLAG` lacks the
bit. So `creationTimeMs` is always `undefined` in production and
`isWindowsProcessStartTimeAvailable()` is always `false` — a latent product gap
that predates the split and needs its own owner.

Two consequences. `IDENTITY_PROJECTION.flags` evaluates to `0` today, so the
identity reader really does open zero handles. And
`agent-session-process-identity-probe.ts` early-returns on
`isWindowsProcessStartTimeAvailable()` rather than scanning the whole table to
produce `null`. Do not build anything on Windows start time working.

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
bounded the _rate_ of new callbacks but not the total: a permanently wedged
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
what is already compiled inside it. On a host that _already had_ MSVC Build
Tools 2022 installed, that build still failed:

```
error MSB8040: Spectre-mitigated libraries are required for this project.
```

That is the requirement the `binding.gyp` hunk of our patch deletes, and the
patch cannot reach a remote host — pnpm patches do not cross SSH. Relay deploy
would then break outright rather than degrade: `installNativeDeps` throws on
failure, and the toolchain-skip retry is gated to Linux.

**Skipping the build and using the shipped binary returns a truncated table.**
Contrary to what this file used to claim, the published 0.8.0 tarball _does_
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
hunk fails _silently_, and the relative gyp path dies at configure on Windows.
The source is checked rather than the install trusted. It also reads the PE
machine field of the output, because a cross-build that quietly emitted host
arch would ship a binary the target cannot load.

Windows arm64 cross-compiles from the x64 runner — verified on real hardware,
producing `IMAGE_FILE_MACHINE_ARM64` (0xaa64) against x64's 0x8664. It needs the
optional _MSVC v143 ARM64 build tools_ component; without it node-gyp fails with
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

`config/patches/@vscode__windows-process-tree@0.8.0.patch` carries five changes.

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
4. **No PEB reads, no `PROCESS_VM_READ`.** See below.
5. **The `CreationTime` flag (4).** Upstream exposes no process start time, and
   `isWindowsProcessStartTimeAvailable()` gates structured Claude and Codex
   chat on it, so without this change win32 silently fell back to the legacy
   transcript path. `GetProcessCreationTime` opens
   `PROCESS_QUERY_LIMITED_INFORMATION` and converts `GetProcessTimes`' FILETIME
   to Unix ms; a process that denies the handle is emitted with the field
   absent, never zero, because callers must be able to tell "cannot identify"
   from a timestamp.
5. **`supportedProcessDataFlags`.** `addon.cc` exports the flag bits the
   compiled binary understands, and `lib/index.js` re-exports it.

   Why a fifth hunk and not just the enum: unlike `node-pty`, this package
   publishes a prebuilt `.node` at the same `build/Release/` path node-gyp
   writes to. pnpm patches the source tree and leaves that prebuilt alone, so a
   host can hold a patched `lib/index.js` — `ProcessDataFlag.CreationTime` and
   all — over a binary that ignores flag 4. CI produced exactly that: the gate
   read available and every row came back without `creationTimeMs`. Neither a
   load check nor a path check can see the difference, so the binary has to say
   so itself.

   Two readers depend on it. `isWindowsProcessStartTimeAvailable()` returns
   false unless this bit is set, because claiming otherwise leaves
   `captureWindowsDescendantSnapshot` returning null forever while structured
   chat believes it has a reaper. And `windows-process-tree-creation-time.cjs`
   asserts it during install, which is what forces a from-source rebuild —
   the same role `node-pty-job-ownership.cjs` plays for node-pty's job exports.

The typings claim `commandLine` is truncated at 512 characters. Measured, it is
not: the longest observed on a real host was 26,059.

### The command line comes from the kernel, not the target's memory

Upstream, `GetProcessCommandLine` opens every process with
`PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` and issues three chained
`ReadProcessMemory` calls — PEB, `RTL_USER_PROCESS_PARAMETERS`, then the string
— to recover the command line. Walking another process's address space for
credentials-adjacent data on a repeating timer is what a credential dumper does,
so Defender for Endpoint scores it as such regardless of intent. Nothing about
the flag sets above changes that; only removing the read does.

Windows 8.1 added `NtQueryInformationProcess`'s `ProcessCommandLineInformation`
class (60), which returns the same string as a `UNICODE_STRING` the kernel
builds, needing only `PROCESS_QUERY_LIMITED_INFORMATION`. Electron's floor is
Windows 10, so every OS Orca supports has it. The entry point is resolved with
`GetProcAddress` on `ntdll.dll` — it has no import library — and the size is
probed with a null-buffer call that answers `STATUS_INFO_LENGTH_MISMATCH`.

The same hunk drops `PROCESS_VM_READ` from `GetProcessMemoryUsage` and
`GetCpuUsage`, which acquired it and never read an address space:
`GetProcessMemoryInfo` and `GetProcessTimes` are satisfied by
`PROCESS_QUERY_LIMITED_INFORMATION`. Measured, both return identical values
under the weaker right on every process that opens at all.

Measured on Windows 11, ~540 processes, counted in-process by replacing the
addon's import table entries with counting stubs:

| per `CommandLine` scan | before                                    | after                                  |
| ---------------------- | ----------------------------------------- | -------------------------------------- |
| `OpenProcess` calls    | 543                                       | 543                                    |
| desired access         | `0x0410` (`VM_READ \| QUERY_INFORMATION`) | `0x1000` (`QUERY_LIMITED_INFORMATION`) |
| `ReadProcessMemory`    | 1128                                      | **0**                                  |
| p50 / p95              | 13.5 / 14.5 ms                            | 12.3 / 13.5 ms                         |

Command lines were byte-identical on every process both readers recovered
(405/405, and 399/399 and 376/376 on other runs), including a 24,087-character
argv with embedded quotes, non-ASCII characters and trailing whitespace, and a
WOW64 target. The weaker right is also a strict superset in reach: three
processes that refused `PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` granted
`PROCESS_QUERY_LIMITED_INFORMATION`, and none went the other way.

### There is no PEB fallback, deliberately

An earlier revision kept the PEB reader for a kernel without class 60, behind a
latch. That was wrong, and the reason is worth recording: `ClassifyQueryFailure`
mapped `STATUS_INVALID_INFO_CLASS` / `NOT_SUPPORTED` / `NOT_IMPLEMENTED` from
**any single target** onto a process-wide, one-way switch back to
`PROCESS_VM_READ` plus three `ReadProcessMemory` per pid per scan, for the life
of the process, with nothing observable from JS.

The environment this reader exists for is one where an EDR hooks `ntdll`. A hook
that returns `STATUS_INVALID_INFO_CLASS` for a class it does not recognise would
have silently reinstated the exact primitive the patch removes, on precisely the
machines it was written for — and one stray status from one process was enough.
The same applies under Wine or any instrumented `ntdll`.

So the fallback is gone rather than guarded. `GetProcessCommandLine` returns
false and leaves the command line empty, which is already a normal outcome
(`WindowsProcessRow.command` is documented as empty when a process denies a
query handle, and callers fall back to the image name). Degrading to no command
line is recoverable; silently resuming address-space reads is not.

This also makes the property checkable on the artifact rather than the source:
the patched reader never calls `ReadProcessMemory`, so the symbol is absent from
the compiled addon's import table. `inspectWindowsProcessTreeAddon()` in
`config/scripts/windows-process-tree-gyp-rebuild.mjs` is that check, and it is
the only way to tell the two binaries apart — see below. It answers
`clean` / `unpatched` / `missing` rather than a boolean, because a binary that is
not there has not been cleared, and a caller reading `false` as “verified” would
pass exactly the thing the check exists to catch.

Because the returned `UNICODE_STRING` comes from that same hookable boundary,
its `Buffer` and `Length` are bounds-checked against the allocation before the
characters are encoded, and the probed size is capped at the header plus 64 KiB
(`Length` is a `USHORT`) so a bogus size cannot turn into a `bad_alloc` that
fails an entire scan instead of one process.

### The published tarball ships a loadable unpatched prebuilt

`@vscode/windows-process-tree@0.8.0` publishes
`build/Release/windows_process_tree.node` in the tarball. It is node-addon-api,
so it is ABI-stable and loads cleanly under both Node and Electron — and it was
built from unpatched source, so it performs 1179 `ReadProcessMemory` calls and
opens every process at `0x0410` per scan.

That matters because `allowBuilds` is `false` for this package and CI installs
with `--ignore-scripts`, so nothing compiles it at install time. A `require()`
health check cannot tell the two binaries apart, and a rebuild that is skipped —
`rebuild-native-deps.mjs` soft-exits 0 on a Windows file lock during postinstall
— leaves the upstream prebuilt in place and cached.

Four checks close that, all keyed on the absent `ReadProcessMemory` import:

- `ensureWindowsProcessTreeCommandLinePatch()` deletes a binary that still has
  it, so a skipped rebuild fails loudly instead of using the prebuilt;
- `ensure-native-runtime.mjs` treats such a binary as a load failure, which is
  what triggers the rebuild;
- the relay build asserts it on the artifact it just produced;
- `loadWindowsProcessTree()` asserts it again on the addon staged beside a relay
  bundle and refuses to bind one that still imports the symbol, falling back to
  the CIM scan. The build-time assertion is not enough on its own: a bundle and
  the addon beside it redeploy independently, so a host that has not taken a new
  bundle keeps whatever `.node` is already there.

What none of this does is narrow _which_ processes are asked. A detailed scan
still queries every pid, including `lsass.exe`; it now asks with the same right
Task Manager uses instead of `PROCESS_VM_READ`. Restricting the command-line
pass to Orca's own subtree is the complementary change, and it belongs with the
identity/detailed reader split rather than here — a ppid-derived allowlist would
miss exactly the detached, reparented descendants the trackers exist to find
(#9045, #10475), so it needs the job-object membership as its source of truth.

## Packaging

The addon is Windows-only, so it follows the same contract as
`windows-native-registry` (asserted by
`config/scripts/package-electron-runtime-contract.test.mjs`):

- an `optionalDependency`, so a macOS/Linux install tolerates its absence;
- **not** enabled in `allowBuilds` in `pnpm-workspace.yaml` — pnpm installs optional dependencies
  on every host, and macOS/Linux must never run `node-gyp` for it;
- listed in the win32 branch of `rebuild-native-deps.mjs` and
  `ensure-native-runtime.mjs`;
- copied into the packaged `node_modules` for win32 only.

The relay's copy is a separate artifact staged beside the bundle, so a relay host
only picks up a rebuilt addon on redeploy. Until then it keeps whatever binary it
already has, which is why the addon is checked again at load.

## What the snapshot does not provide

`CreationDate` (process start time) now has an equivalent — `creationTimeMs`,
above — but only inside this module. Daemon identity, managed-hook ownership and
CPU accounting in the memory collector still read a start time through their own
queries; those callers are not migrated.

Committed private bytes have no equivalent either, and the one memory value the
addon can produce is unusable for the sizes Orca now sees: `process.cc` stores
`pmc.WorkingSetSize` into a `DWORD`, so anything above 4 GB wraps — which is why
neither flag set asks for it. That is the second reason
`windows-process-resource-collector.ts` still runs its own
`Get-CimInstance` sweep — it needs `PageFileUsage` (commit) and the CPU-time
counters in the same pass. Migrating it to the native table would cost both, and
it is why this module no longer sets the `Memory` flag at all: the field had no
reader, and asking for it opened a handle per process on every snapshot.

Start time is a proxy for identity, not identity. For the process trees Orca
itself spawns the durable answer is still an inherited handle: a job object
names the tree Orca created, so no start-time comparison is needed. The
`creationTimeMs` this snapshot now carries is for the trees Orca did **not**
create the handle for — a recovered agent session, a descendant walked out of
the table — where a bare PID is all there is to re-identify.

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
survive. The job exists to make an _explicit_ teardown exact, not to redefine
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
terminated tree reports `null` rather than `[]`. Null means _unverifiable_ in
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

`requiresPatchedNodePtySourceBuild()` in `ensure-native-runtime.mjs` now covers
win32 as well, and `pnpm rebuild node-pty` sets `npm_config_build_from_source`
so the patched source build actually replaces the upstream prebuild.
