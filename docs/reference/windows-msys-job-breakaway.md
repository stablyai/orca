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

Read the failing line first, because only one of the two shapes is about this
page. A **two-pid job list** at `expect(listPtyJobProcessIds(proc))` is the
breakaway defect or its stale-addon lookalike, below. A test that never gets
`MSYS_OWNED_CHILD` at all is not: it is the ConPTY startup race described in
`windows-msys-job.win32.test.ts`, where input typed before the pty's client has
attached is dropped instead of queued. The same shape reaches the cmd.exe
siblings (`windows-pty-job.win32.test.ts`, `windows-host-job.win32.test.ts`),
which do not touch MSYS at all.

When the job list is short, check the binary before the code:

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

## A stale source tree looks exactly like a stale addon

`rebuild-native-deps.mjs` rejects a marker-less addon in its Electron probe and
again after the rebuild, so an unpatched `build/Release/conpty.node` is never
left in place silently. But the rebuild compiles whatever `node_modules/node-pty`
holds, and pnpm materializes that from the patch only at install time. On a
checkout whose `node_modules` predates the denial, `--force` compiles for
minutes and rewrites `conpty.node` byte-identical and unpatched; measured on a
Windows dev checkout, same size, new mtime, marker still absent. The
post-rebuild gate then said "rebuild from source", which was the step that had
just run.

So the script reads `src/win/conpty.cc` before it compiles: if the source does
not carry `L"msys-2.0.dll"`, it stops before the rebuild and says to run
`pnpm install`, which re-applies the current patch. If the patch itself lacks
the literal, the checkout predates the denial and a reinstall cannot help.

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
| cross arch, built    | patched, target arch          | yes              | `build/Release`    |
| cross arch, failed   | the host's arch               | no               | the prebuild       |

`beforeBuild` runs `rebuild-native-deps.mjs --platform=win32 --arch=<target>`, so
a cross-arch slice normally does get a patched `build/Release` for the target —
row three is a correct package. `prunePackagedNodePty` asks the same question the
loader does, reading the PE machine of `build/Release` rather than comparing
`electronArch` to `process.arch`, so row three's leftover prebuild goes. Keying
off the host arch kept it: unreached in the normal case, but still the binary the
loader takes if `build/Release` ever fails to load for an unrelated reason — an
AV quarantine, a missing dependency — which is the silent fall-through this whole
gate exists to close. Rows two and four keep the prebuild because it is the only
thing there the target could load. Measured on Windows 11 x64 with the VS 2022
ARM64 cross toolset: `node-gyp rebuild --arch=arm64` does emit a `conpty.node`
with machine `0xaa64`, so row three is a real package shape — but as of this
writing no release produces it, because `electron-builder --win` is run without
an arch and packages x64 only.

The verifier still does not key on presence: the prune is the step it is
checking, and `build/Debug` is never pruned, so an unmarked file beside a
correct `build/Release` cannot by itself separate row three from row four, and
failing on one would reject a correct package with advice its builder could not
act on. `verifyPackagedConptyBreakawayMarker` instead resolves the
addon the way the loader does — first candidate whose PE `IMAGE_FILE_HEADER`
machine matches the target — and checks the marker on that one. A package with
no candidate at all, or none of the target's architecture, is refused: it has no
ConPTY backend to load.
