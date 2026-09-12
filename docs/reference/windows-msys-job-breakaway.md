# Why an MSYS pane's children escape the per-PTY job

Every child started from a Git Bash / MSYS2 / Cygwin pane leaves the pane's job
object unless the job is created **without** `JOB_OBJECT_LIMIT_BREAKAWAY_OK`.
`terminatePtyJob` then reports `terminated` and leaves the child running — the
orphan that holds a worktree directory open.

The denial is already in `config/patches/node-pty@1.1.0.patch`
(`usesCygwinRuntime`, added in #19068). This page records the measurement
behind it, because the failure mode it prevents is indistinguishable from a
stale native addon and the existing gates cannot tell the two apart.

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

`config/scripts/node-pty-job-ownership.cjs` asserts only that `terminateJob`,
`listJobProcessIds` and `assignCurrentProcessToJob` are exported. All three
predate #19068, so a `conpty.node` built before it passes every gate,
`isPtyJobOwnershipAvailable()` returns true, `windows-pty-job.win32.test.ts`
passes 6/6 — and `windows-msys-job.win32.test.ts` fails with a two-pid job list
that reads as a source defect rather than a build-freshness one.

When that test fails, check the binary before the code:

```js
// UTF-16LE, because usesCygwinRuntime holds the literals
readFileSync(conptyNodePath).includes(Buffer.from('msys-2.0.dll', 'utf16le'))
```

False means the addon predates the fix; rebuild node-pty from patched source.
Note that a git worktree sharing `node_modules` with its main checkout shares
that checkout's `build/Release/conpty.node`, so pinning the _source_ to a commit
does not pin the _addon_.

The gate should assert the same marker, the way `stagedRelayAddonIsUnpatched()`
in `src/main/windows/windows-process-table.ts` already sniffs a patched addon by
a binary import name. Symbol presence cannot distinguish patch revisions; a
marker or an exported revision number can.

## What a real Windows packaging run measures

Run on `awin` (Windows 11 `10.0.26200`, x64, node `v24.18.0`, pnpm `12.0.0`)
from a standalone clone of `inv18191-msys-job-breakaway` at `f9850f9bc57` with
its **own** `node_modules` — not a symlink to another checkout — so the addon
under test was built by that install (`conpty.node`, x64, marker present).

`electron-builder --dir` for **win32-x64** takes the same-host branch and logs
`OK — packaged ConPTY owns process trees`. Packaging for **win32-arm64** from
the same x64 host takes the cross-arch branch and logs
`skipped cross-platform or cross-arch package` followed by
`OK — packaged ConPTY denies MSYS job breakaway`, so the marker half does run
on a package the export half cannot load.

Both halves fail packaging, not just log:

| slice | addon put in front of the gate       | result                                                    |
| ----- | ------------------------------------ | --------------------------------------------------------- |
| x64   | the stale addon from a real checkout | exit 1, thrown from `verifyPackagedNodePtyJobOwnership`   |
| arm64 | same-arch build, marker byte-patched | exit 1, thrown from `verifyPackagedConptyBreakawayMarker` |

The stale addon reaches the export check and passes it, failing only on the
marker — the export/marker split is doing real work, not duplicating a check.

Isolating the afterPack gate needs `beforeBuild` stubbed out: with it active,
`rebuild-native-deps.mjs` rebuilds the poisoned addon from patched source before
`afterPack` ever sees it. That heal is the desired behaviour; it just means a
poisoned `node_modules` alone cannot prove the packaged-side gate.

## The layout the verifier assumes, against what it actually gets

`packagedConptyPath()` resolves one path, and both real slices put an addon
exactly there:

```
resources/node_modules/node-pty/build/Release/conpty.node
```

x64 ships nothing else that `loadNativeModule` would reach. **arm64 also ships
`prebuilds/win32-arm64/conpty.node`, and that one has no marker.** The
asymmetry is deliberate: `prunePackagedRuntimeNodeModules` deletes the
unpatched prebuild only when `electronArch === process.arch`, because on a
cross-arch package `build/Release` may hold the host's addon and deleting the
target-arch prebuild would remove the only loadable binary.

Two consequences for a cross-host or cross-arch Windows release, neither
covered today:

- The shipped `prebuilds/win32-<arch>/conpty.node` is unpatched and is what
  `loadNativeModule` falls through to if `build/Release/conpty.node` fails to
  load (wrong ABI, AV quarantine). The verifier never reads it.
- When `build/Release/conpty.node` is absent, `verifyPackagedConptyBreakawayMarker`
  warns and returns — and that is precisely the package whose only loadable
  conpty is the unpatched prebuild.
