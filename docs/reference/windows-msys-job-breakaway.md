# Why an MSYS pane's children escape the per-PTY job

Every child started from a Git Bash / MSYS2 / Cygwin pane leaves the pane's job
object unless the job is created **without** `JOB_OBJECT_LIMIT_BREAKAWAY_OK`.
`terminatePtyJob` then reports `terminated` and leaves the child running — the
orphan that holds a worktree directory open.

The denial is already in `config/patches/node-pty@1.1.0.patch`
(`usesCygwinRuntime`, added in #19068). This page records the measurement
behind it, because the failure mode it prevents is indistinguishable from a
stale native addon and the gates of the day could not tell the two apart.

## The mechanism

The MSYS/Cygwin runtime asks for `CREATE_BREAKAWAY_FROM_JOB` on the
`CreateProcessW` inside its `spawn`/`exec` path. A job that carries
`JOB_OBJECT_LIMIT_BREAKAWAY_OK` grants it, so the child is created outside the
job; a job without that limit denies it with `ERROR_ACCESS_DENIED`, and the
runtime retries without the flag rather than failing the spawn. `fork` is not
affected — forked Cygwin processes stay in the job either way.

Measured on Windows 11 `10.0.26200.9168`, Git `2.55.0.windows.3`,
bash `5.3.15(1)-release`, node `v24.18.0`, `useConptyDll: true`, for
`node-pty.spawn('C:\Program Files\Git\bin\bash.exe', ['--noprofile','--norc','-i'])`
— `+J` / `-J` is membership of the per-PTY job, read with
`QueryInformationJobObject(JobObjectBasicProcessIdList)`:

```
bin\bash.exe            +J   ConPTY shell (assigned by node-pty)
 └ ..\usr\bin\bash.exe  +J   launcher hand-off, plain CreateProcess
    └ usr\bin\bash.exe  +J   Cygwin fork for the typed command
       └ node.exe       -J   Cygwin exec -- ESCAPES HERE
```

`bin\bash.exe` is a 47 KB launcher, not an MSYS binary: `C:\Program Files\Git\bin`
holds only `bash.exe`, `git.exe` and `sh.exe`, with no `msys-2.0.dll`. Its
hand-off to `bin\..\usr\bin\bash.exe` is an ordinary `CreateProcess` and keeps
job membership. Only the MSYS runtime's own spawn breaks away.

The shell-replacement shape (`bash -c 'exec "$BASH" --noprofile --norc -i'`)
loses membership one step earlier, at the `exec`, and everything below inherits
the loss:

```
bin\bash.exe            +J
 └ ..\usr\bin\bash.exe  +J
    └ usr\bin\bash.exe  -J   Cygwin exec -- ESCAPES HERE
       └ usr\bin\bash   -J
          └ node.exe    -J
```

Both shapes leak. The `exec` is not the cause; it only moves the escape earlier.

## The A/B that pins it

One source tree, one toolchain, one variable — `usesCygwinRuntime` forced to
`false` so the per-PTY job keeps `JOB_OBJECT_LIMIT_BREAKAWAY_OK`:

| per-PTY job limit      | `listPtyJobProcessIds` | child reaped by `terminatePtyJob` | runs |
| ---------------------- | ---------------------- | --------------------------------- | ---- |
| `BREAKAWAY_OK` set     | 2 pids, child absent   | no                                | 0/2  |
| `BREAKAWAY_OK` cleared | 5 pids, child present  | yes                               | 4/4  |

The job **is** the right boundary. With breakaway denied it holds the whole MSYS
tree, including the child that detached from the console, and one
`terminateJob` reaps all of it. No alternative tracking mechanism is needed.

Denying breakaway did not break ordinary launches from the pane: `git`,
`cmd //c`, an absolute-path `node`, a `&`-backgrounded job with `disown`, and
`where.exe` all returned 0 with no `Access is denied`, identically to the
breakaway-allowed control. Untested: a **non-Cygwin** program that itself passes
`CREATE_BREAKAWAY_FROM_JOB` (installers, updaters) and therefore has no runtime
to retry for it. That needs a helper that calls `CreateProcess` with the flag;
`start /b` does not exercise it (it uses `CREATE_NEW_CONSOLE`).

## A stale addon looks exactly like the bug

`config/scripts/node-pty-job-ownership.cjs` used to assert only that
`terminateJob`, `listJobProcessIds` and `assignCurrentProcessToJob` are
exported. All three predate #19068, so a `conpty.node` built before it passed
every gate: `isPtyJobOwnershipAvailable()` returned true and
`windows-pty-job.win32.test.ts` passed 6/6, while
`windows-msys-job.win32.test.ts` failed with a two-pid job list that read as a
source defect rather than a build-freshness one.

When that test fails, check the binary before the code:

```js
// UTF-16LE, because usesCygwinRuntime holds the literals
readFileSync(conptyNodePath).includes(Buffer.from('msys-2.0.dll', 'utf16le'))
```

False means the addon predates the fix; rebuild node-pty from patched source.
Note that a git worktree sharing `node_modules` with its main checkout shares
that checkout's `build/Release/conpty.node`, so pinning the _source_ to a commit
does not pin the _addon_.

The gate asserts that marker, the way `stagedRelayAddonIsUnpatched()` in
`src/main/windows/windows-process-table.ts` already sniffs a patched addon by a
binary import name. Symbol presence cannot distinguish patch revisions; a marker
can.

Because the marker is a literal in `conpty.cc` and the gate's copy of it is a
separate constant, `ensure-native-runtime-job-ownership.test.mjs` asserts the
patch still adds `L"msys-2.0.dll"` to that file. Without that, editing the patch
would turn the gate into a permanent false positive that fails every correctly
rebuilt addon and tells the developer to do the one thing that cannot help.

## Every path the loader can fall through to

`loadNativeModule` tries `build/Release`, then `build/Debug`, then
`prebuilds/win32-<arch>`, each relative to node-pty's root and then to `lib/`,
swallowing every failure in between. A require of a wrong-architecture `.node`
is one of those failures, so the candidate that runs is the first one the target
arch can actually load. The published prebuild is always the last candidate and
never carries the patch:

| package              | `build/Release`               | prebuild pruned? | what the app loads |
| -------------------- | ----------------------------- | ---------------- | ------------------ |
| same host, same arch | patched                       | yes              | `build/Release`    |
| cross host           | absent, cannot be cross-built | no               | the prebuild       |
| cross arch, built    | patched, target arch          | no               | `build/Release`    |
| cross arch, failed   | the host's arch               | no               | the prebuild       |

`beforeBuild` runs `rebuild-native-deps.mjs --platform=win32 --arch=<target>`, so
a cross-arch slice normally does get a patched `build/Release` for the target —
row three is a correct package whose leftover prebuild is never reached.
`prunePackagedNodePty` keeps that prebuild anyway, because its guard is
`electronArch === process.arch` rather than the arch of the binary.

So presence alone cannot separate row three from row four, and failing on any
unmarked file present would reject a correct package with advice its builder
could not act on. `verifyPackagedConptyBreakawayMarker` instead resolves the
addon the way the loader does — first candidate whose PE `IMAGE_FILE_HEADER`
machine matches the target — and checks the marker on that one. A package with
no candidate at all, or none of the target's architecture, is refused: it has no
ConPTY backend to load.
