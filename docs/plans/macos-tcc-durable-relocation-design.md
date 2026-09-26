# macOS terminal daemon: preserve TCC access across updates (Layer 2)

## Status banner — this design is inconclusive (updated 2026-09-19)

**Do not build any launch-mechanism change (M2, M3, M4, or M6) off this document yet. The core
premise is unconfirmed.** After a further investigation session (section 12), the failure this
design prevents has still never been reproduced under measurement, and the strongest field
evidence now points at a mechanism that *no* launch-mechanism change would fix.

What is actually settled is small: the daemon's `node-pty` `spawn-helper` cannot exec while the
bundle path is absent (measured, section 9.1), so *some* stable runtime is needed regardless of
attribution — but that is a PTY-survival fact, not a TCC fact. Everything about TCC attribution in
this document is either inferred from source and documentation or measured on hosts that could not
reproduce the denial.

Two distinct failure modes are now on the table and this design only addresses one of them:

1. **Path-unresolvable re-evaluation** — a TCC check lands during the Squirrel swap gap while the
   responsible executable's path cannot be resolved. M2 and M6 would fix this; M3 would not. This
   is the mode the document assumes. **It has not been reproduced.**
2. **Tahoe kernel-cache poisoning** — a cached *allow* verdict, keyed to the responsible process,
   is flushed and re-served as a *deny* by the kernel while `TCC.db` still says allow and `tccd`
   is never consulted. The responsible executable's *path never moves* in this mode, so M2, M3,
   and M6 all change nothing. This is what the strongest field evidence matches
   (`anthropics/claude-code#91118`, filed from Orca itself; also `#58952`, `ghostty#12947`,
   `cmux#2866`). If this is Orca's actual failure, the fix belongs in the **recovery** design
   (detect + `tccutil reset`), not here.

The one measurement that decides which mode Orca hits — reproduce the denial on an isolated host
with Full Disk Access **off** — has not been achieved. Both hosts available in the investigation
had FDA granted to `com.stablyai.orca`, which short-circuits every per-folder evaluation and makes
every clean result meaningless for attribution (this is the same confound section 9.2 identified,
and it recurred). Until N0 (today's fork path) reproduces a denial under measurement, no positive
result from any candidate proves anything. See section 12 for the full account.

## Decision update — 2026-09-14

Prioritize preventing permission loss in surviving sessions. The same daemon, shell, and running
agent must remain alive and able to access protected folders through an app update and subsequent
GUI exit/relaunch. A successful new terminal on a replacement daemon does not prove this fix.

The recovery document covers an explicit, destructive restart for already affected daemons:
[explicit recovery](macos-tcc-explicit-recovery-design.md).
Both documents describe the same reported failure. Layer 2 owns preventing its recurrence;
recovery cannot repair a running process's launch ancestry and cannot substitute for prevention.

Implementation order:

1. Recover or rebuild the signed-build reproduction, with recorded OS/build/signing identity,
   permission setup, process identities, update operations, and raw results. Treat the reported
   path-resolution/cache mechanism below as the working hypothesis until reproduced. A missing
   tccd log entry alone does not establish where a denial is cached or its lifetime.
2. Compare the existing fork, fork from a stable clone, launchd without a clone, launchd with a
   clone, and a responsibility-disclaim prototype under identical conditions. The responsibility
   probe already run here was inconclusive. Launchd plus a pinned clone is the leading candidate,
   not a validated final choice; sections 5–8 describe that candidate conditionally.
3. Select the least complex candidate that preserves existing-session access and satisfies the
   startup, environment, ownership, and update-survival contracts. Keep a stable runtime if tests
   show it is needed for executable/resource survival, even if attribution alone needs no clone.
4. Implement and verify that candidate in isolation, then roll out to hourly. Existing old-style
   daemons retain their sessions and retire naturally; explicit recovery is available when the
   user accepts session termination. Do not add generation routing or a protocol bump solely to
   move fresh terminals off an old daemon as part of this prevention change.

The updates in this decision and the acceptance section supersede conflicting prescriptions
below. No production implementation or signed-update validation has been completed by this doc.

Status: design, not implemented. Written 2026-09-13 against `main` at `3763103084` after
inspecting `src/main/daemon`, the macOS packaging config, and the Layer 1 branch
(`AmethystLiang/fix-agent-icon-eperm-error`) with its plan and reference doc. Background:
`.context/macos-daemon-tcc-fix-plan.md` and `docs/reference/macos-daemon-tcc-attribution.md`
on that branch (neither is on `main`; the reference doc must land with this work).

Companion reading: `src/main/daemon/AGENTS.md` (endpoint ownership invariants),
`docs/reference/windows-daemon-host-relocation.md` (the Windows analog and its EDR history),
`docs/reference/remote-wire-compatibility.md` (Rule 1 governs every field added here).

---

## 1. What is broken, restated against the code

The reported mechanism (reference doc, "The mechanism, as measured"), pending reproduction:

1. Every access from a daemon-hosted terminal is attributed to the app that forked the daemon:
   by pid while that app lives, by its recorded executable path afterwards. The daemon's own
   image is not consulted.
2. One evaluation while that path cannot be resolved caches a denial against the daemon's whole
   lineage for the daemon's lifetime. Restoring the path does not clear it; only daemon death does.
3. Squirrel.Mac installs by moving `/Applications/Orca.app` out and the new bundle in, so the path
   is absent for a moment on every update, and the parked copy is emptied on the update after.

How the current code produces exactly that lineage:

- `createOutOfProcessLauncher` (`daemon-out-of-process-launcher.ts`) calls `launchDaemonChild`
  (`daemon-launched-child.ts`), which `fork()`s `daemon-entry.js` from `process.execPath`, the
  installed `Orca.app/Contents/MacOS/Orca`, with `detached: true` and an `ipc` channel for the
  `{type:'ready'}` handshake. The app process is therefore the daemon's TCC responsible process.
- `materializeRelocatedDaemonHost` (`daemon-host-relocation.ts`) returns `null` off win32
  (`isPackagedElectronWin32`), so macOS never relocates anything.
- `--spawner-exec-path process.execPath` is persisted into the pid record (`DaemonPidFile`,
  `daemon-spawner.ts`) and echoed in the hello identity (`DaemonEndpointIdentity`,
  `daemon-hello-protocol.ts`, served from `daemon-client-connections.ts`).
- `getMacDaemonTccAttributionHealth` (`daemon-tcc-attribution.ts`) reports `severed` when that
  path no longer exists and `intact` otherwise. On `main` it is an existence check only; the
  Layer 1 branch turned it into a measured-divergence verdict and that branch did not help in the
  field (plan, "Why Layer 1 failed") because poisoned daemons run older code that never reports.
- `prepareDaemonReplacement` (`daemon-replacement-preflight.ts`) replaces a healthy daemon only
  at zero live sessions (`stale_bundle`, `different_app_path`, `severed_tcc_attribution`);
  with live sessions it preserves the daemon. So a user who always has terminals open keeps a
  poisoned daemon indefinitely, and every fresh terminal lands on it.

Layer 2's job is to prevent update-induced permission loss for daemons launched by the new code
while preserving their existing PTYs and agents. It does not cure already affected processes.

## 2. Assertions in the plan that were challenged

| Claim (plan or reference doc)                                                                                                        | Status                                                                                                                                                                                                                                                                                                                                                                                                                            | Consequence for this design                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Validated in the harness across an in-place replacement by a different signed build and an outright deletion"                       | Unreproducible: no harness exists on `main` or on the Layer 1 branch (`tests/tools` has only `daemon-relocation-spike`, a Windows file-closure probe, and the Windows update e2e).                                                                                                                                                                                                                                                | The harness is a deliverable of this work (section 9), and it must include a negative control that reproduces the denial on the old launch path before any positive result counts.                                                    |
| "Make the daemon its own responsible process, launched by launchd from an Orca-owned clone" and "Do not assume launchd is necessary" | Two separable properties: (a) the daemon must be its own responsible process; (b) the responsible executable must sit on a path the updater never touches. launchd gives (a); the clone gives (b). Mechanism 1 says a plain fork inherits the app as responsible process regardless of which binary it executes, so a direct fork from the clone changes nothing.                                                                 | Direct fork from the clone is rejected on measured evidence, not on taste (section 4). A `posix_spawn` responsibility disclaim would also give (a) without launchd but is unmeasured, so it is a harness row, not the recommendation. |
| "On APFS the clone is a `clonefile` copy, so it costs almost nothing"                                                                | Measured here: `cp -cR` of the installed 513 MB bundle took 0.62 s wall, 0.007 s user, and `codesign --verify --strict` passed on the clone's main executable. Node has no `clonefile` binding; `cp -c` falls back to a full copy across volumes or on non-APFS.                                                                                                                                                                  | Use `/bin/cp -cRp` through `runProcess`, off the first-paint path, with a full-copy fallback and a size/verification gate.                                                                                                            |
| "Extend `daemon-host-relocation.ts` with a macOS branch rather than adding a parallel system"                                        | The Windows materializer does `rmSync(dest)` then `renameSync(staging, dest)` and copies with `dereference: true`. Both are wrong on macOS: deleting or rewriting a directory a running daemon executes from is the poison we are removing (and rewriting a mapped signed binary gets the process killed on page-in), and dereferencing symlinks breaks the framework `Versions/Current` layout the signature and dyld depend on. | Share the pin/prune shape (`collectPinnedDaemonVersions`, `reclaimUnownedDaemonHostDir`) and the marker-last publish idea; the copy plan and the never-delete rule are macOS-specific code.                                           |
| "Socket, token, pid record, adoption, and restart stay as they are"                                                                  | Not true for launch. Readiness today is Node IPC on a `ChildProcess`; the identity fence in `holdDaemonAdoptionLease` compares `child.pid`; failure cleanup is `terminateLaunchedDaemonChild(child)`; stderr is captured from the child pipe. None of that exists under launchd.                                                                                                                                                  | Section 5.3 specifies the replacement readiness protocol. Everything from the adoption lease onward is unchanged.                                                                                                                     |
| "The identity of the clone is the same signed `com.stablyai.orca`, so existing grants apply"                                         | True for notarized Developer ID builds (grants keyed on identifier + team, `electron-builder.config.cjs` comment at `notarize`). Not true for dev builds: `node_modules/electron` is ad-hoc signed under `com.github.Electron`, so grants are per-cdhash and re-prompt on every Electron bump anyway.                                                                                                                             | Packaged asar builds only by default; dev builds opt in with an env var (section 5.10).                                                                                                                                               |
| "Once this ships, supersede-on-update becomes rare (protocol bumps only)"                                                            | Only if old-style daemons are actually superseded. Without a migration path, a poisoned old-style daemon with live sessions keeps receiving fresh terminals forever.                                                                                                                                                                                                                                                              | Migration rides on a protocol bump so the existing legacy-adapter path demotes old-style daemons (section 5.6).                                                                                                                       |
| "Version skew, PPID 1, a deleted spawner binary ... do not cause it on their own"                                                    | Consistent with the code: `isDaemonStaleForCurrentBundle` and `getDaemonLaunchIdentity` are freshness checks, not attribution checks.                                                                                                                                                                                                                                                                                             | Keep them as they are. The new `intact` definition (section 5.5) stays fail-open.                                                                                                                                                     |
| Local probe on this machine (macOS 26.5.1)                                                                                           | `responsibility_get_pid_responsible_for_pid` returned the queried pid for every process including the live daemon and a freshly `posix_spawn`ed child with and without disclaim; `launchctl procinfo` needs root. Inconclusive.                                                                                                                                                                                                   | No design decision rests on it. It is recorded so nobody re-runs it expecting a verdict.                                                                                                                                              |

## 3. Goals, non-goals, invariants

Goals

- Preserve access in the same daemon and its existing sessions across Squirrel updates,
  same-version reinstalls, and app quits, with executable/resource lifetime protected as needed.
- Existing live PTYs and agent sessions are never killed by the rollout, on any path.
- Old-style daemons remain adopted until natural retirement or explicit restart; their continued
  use must not be counted as successful migration to the prevention mechanism.
- A pre-launch materialization failure may fall back to the existing fork path with telemetry.
  After bootstrap starts, prove that attempt settled before any fallback; uncertainty preserves
  ownership and must not create a competing daemon.

Non-goals

- Detecting or curing a denial on an already-poisoned daemon (Layer 1's problem; the plan drops it).
- Changing shell login wrapping itself. The responsible-process attribution inherited by terminal
  children is precisely what this design investigates and may need to change.
- Windows and Linux launch behavior.
- Making the daemon survive logout or reboot.

Invariants carried over, with the file that enforces each

- Endpoint ownership: only the publishing daemon mutates the canonical socket entry, and only by
  replacing one it proved dead (`daemon-endpoint-ownership.ts`, `AGENTS.md`). launchd changes who
  execs the daemon, not who owns the socket.
- Liveness vocabulary is `live` / `unverifiable` / `exited`; `unverifiable` never licenses
  deletion (`daemon-process-inspection.ts`, `reclaimUnownedDaemonHostDir`).
- No sweeper. Every actor removes only names it created, and only after proving them dead.
- Wire changes are additive optional fields only (Rule 1). Old daemons omit them and every reader
  falls back.
- SSH and folder-workspace cases: the daemon is a local execution host concern; nothing here
  reports remote work or assumes a git worktree. Headless `orcad` has no bundle and is excluded by
  construction (section 5.10).

## 4. Launch mechanism comparison and decision

Five candidates, all executing the same `daemon-entry.js` with the same argv:

|                                        | M0 fork from `/Applications` (today)  | M1 direct fork from clone                                               | M2 transient launchd agent from clone                                                                   | M3 launchd agent from `/Applications`, no clone                                                                                                                                                                                                   | M4 `posix_spawn` with responsibility disclaim from clone                       |
| -------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Responsible process                    | App, then its recorded path           | App, then its recorded path (mechanism 1: image executed is irrelevant) | The daemon itself                                                                                       | The daemon itself                                                                                                                                                                                                                                 | The daemon itself (by construction of the API; unmeasured for tccd)            |
| Responsible path stable across updates | No                                    | No                                                                      | Yes (pinned clone)                                                                                      | No (Squirrel swaps it)                                                                                                                                                                                                                            | Yes (pinned clone)                                                             |
| Measured TCC evidence                  | Reproduces the denial (reference doc) | Implied failing by mechanism 1; not run as its own row                  | Pass through replacement and deletion, with and without `login(1)` (reference doc, harness not in tree) | Local run 2026-09-14: no denial through park, restore and delete, but the negative control on the same machine did not reproduce either, so attribution is unsettled; PTY spawns fail with `ENOENT` while the bundle path is absent (section 9.1) | None                                                                           |
| Readiness signal                       | Node IPC `ready`                      | Node IPC `ready`                                                        | Hello over the socket keyed by launch nonce, plus an exit-reason file                                   | Same as M2                                                                                                                                                                                                                                        | Node IPC could survive if the helper passes the channel fd through; unverified |
| Env and cwd                            | Inherited from the app                | Inherited                                                               | Explicit allow-list in the plist                                                                        | Same                                                                                                                                                                                                                                              | Inherited                                                                      |
| Extra moving parts                     | None                                  | Clone                                                                   | Clone, plist, `launchctl`, label pruning                                                                | plist, `launchctl`                                                                                                                                                                                                                                | Clone, a signed native helper in `Contents/MacOS`                              |
| Runs without a GUI login session       | Yes                                   | Yes                                                                     | No (`gui/<uid>` domain required; fail open to M0)                                                       | No                                                                                                                                                                                                                                                | Yes                                                                            |

Provisional candidate: M2. Its reported success has not been reproduced here. M1 is predicted to
fail by the working hypothesis; run it rather than treating that prediction as a measurement.
M3 passing would challenge the need for a clone for attribution, but executable and resource
survival still need testing before removing the clone. M4 could remove launchd, the plist, and the
domain dependency, but its private API and signing/compatibility costs must also be assessed.
Do not adopt it before measurement; it needs a signed helper (the pattern already exists:
`orca-notification-status` and `orca-keyboard-layout` are signed by `signMacStandaloneHelper` in
`electron-builder.config.cjs`).

Why not "launchd from the clone" as an assumption-free choice: it costs a plist, a subprocess, a
domain requirement, and a new readiness protocol. Those are paid because the alternative
readiness path (Node IPC) cannot exist under launchd, not because launchd is elegant. If M4
measures equal, the design's sections 5.1, 5.4 to 5.13 carry over unchanged and only 5.2 and 5.3
shrink.

## 5. Design

### 5.1 Materialization: an immutable, generation-keyed clone

New module `src/main/daemon/macos-daemon-host-clone.ts` (named for what it contains; not a
`helpers` file).

Applicability gate, mirroring `isPackagedElectronWin32`:
`process.platform === 'darwin' && getAppEnvironment().isPackaged() && getAppPath().includes('app.asar')`,
plus the opt-in for dev (5.10) and the kill switch (5.13). `orcad` fails the asar test and stays
on the fork path.

Source bundle: resolve from `process.execPath` upward to the directory whose `Contents/Info.plist`
exists (three levels for `Contents/MacOS/Orca`). Translocated or non-`/Applications` installs
are valid sources; the clone does not care where the source lives.

Generation identity: the CDHash of the installed main executable, read once per app launch with
`codesign -dvvv <exe>` through `runProcess` (24 ms measured) and parsed from the `CDHash=` line.
CDHash is the immutable identity of a signed executable, so a same-version reinstall of a
different build (dev channels reusing a version, a CI re-run) gets a new generation, and the same
build reinstalled reuses the existing one. `appVersion` is not the key; the Windows code's known
fail-open on same-version reinstall is exactly what a version key buys. Fallback when `codesign`
fails (unsigned local build): sha256 of `Contents/Resources/orca-local-build.json` (`buildId`
from `mac-build-compatibility.cjs`) plus the executable's size. Generation ids are hex, so they are
safe as directory names.

Layout: `<userData>/daemon-host/<generation>/Orca.app` (the bundle keeps its own name, per the
Windows verbatim-name lesson), with `<userData>/daemon-host/<generation>/.materialized.json`
written last. Per-userData rather than a shared root so profiles (`orca`, `orca-dev`, e2e
override, `--user-data-dir`) never pin or prune each other's clones; APFS block sharing makes the
duplication free.

Copy: `/bin/cp -cRp <source> <staging>/Orca.app` via `runProcess`. `-c` clones with
`clonefile(2)` and falls back to a copy across volumes; `-R` without `-L` preserves symlinks;
`-p` preserves modes and times. Measured 0.62 s for 513 MB. Off the first-paint path, like the
Windows materializer ("lazy so it's off first-paint"). `fs.cpSync` with `COPYFILE_FICLONE` and
`verbatimSymlinks: true` is the in-process alternative; it is not chosen only because it was not
measured on the bundle.

Post-copy gate, first pass, in staging, before publish: a smoke exec of the clone as Node
(`ELECTRON_RUN_AS_NODE=1 <clone>/Contents/MacOS/Orca -e 0`, about 100 ms). Two of the first three
launchd launches of a fresh clone on this machine died in `dyld` reporting a framework dylib as
"no such file" although the file existed and the same clone later ran; every launch preceded by a
direct exec succeeded (section 9.1). The cause is unexplained, so the gate is empirical: a clone
that has not executed once is not published. Then `codesign --verify --strict` on the clone's main
executable; the clone's `Contents/MacOS/Orca` size equals the source's; and `xattr -dr
com.apple.quarantine` on the clone tree only, never on the source. Squirrel-installed bundles carry
no quarantine (verified on this machine: `com.apple.provenance` and `com.apple.macl` only), but a
DMG install does, and exec of a quarantined binary from a new path is a Gatekeeper assessment we do
not want on the daemon path. Any gate failure discards staging and fails open.

Atomicity: stage into `<root>/<generation>.staging-<12 hex>`, write the marker last, then a single
`renameSync(staging, final)`. If the rename fails with `ENOTEMPTY` or `EEXIST`, a concurrent
materializer won; read its marker, discard our staging, use theirs. Never `rmSync` a final
generation directory here. A marker-less directory is never used and is reclaimed only by pruning
(5.7).

Immutability: after publish nothing opens the generation directory for writing. The daemon's
`cwd` is `userData`, not the clone. Logs go to the logs directory. Rewriting a file a running daemon
has mapped would kill it with a code-signature fault; deleting it would recreate the unresolvable
responsible path. Both are prevented by pinning, not by `chflags`.

### 5.2 Launch: a transient per-user launchd agent

New module `src/main/daemon/macos-daemon-launchd-agent.ts`: `renderDaemonLaunchdPlist`,
`bootstrapDaemonLaunchdAgent`, `bootoutDeadDaemonLaunchdAgents`, `readDaemonLaunchdServiceState`.
All subprocesses go through `runProcess` from `src/shared/child-process/`.

Label: `com.stablyai.orca.terminal-daemon.<sha256(runtimeDir)[0:12]>.<launchNonce[0:8]>`. The
runtime-dir hash separates profiles; the nonce makes every launch unique so a replacement never
collides with a dying incumbent's label.

Plist location: `<runtimeDir>/launchd/<label>.plist`, mode 0600, in the 0700 runtime dir
(`ensurePrivateDir` in `daemon-launch-paths.ts`). Never `~/Library/LaunchAgents`: nothing may
persist across reboot or autostart at login.

Plist content:

- `Label`.
- `ProgramArguments`: `<clone>/Contents/MacOS/Orca`, `<clone entry path>`, then exactly the argv
  `launchDaemonChild` builds today (`--socket`, `--token`, `--pid-record`, `--launch-nonce`,
  `--entry-path <install-dir entry>`, `--app-version`, `--spawner-exec-path`,
  `--login-session-watch` when GUI, `daemonLogArgs()`), plus the new `--host-generation
<generation>`, `--launch-mechanism launchd`, `--exit-reason-file <runtimeDir>/launchd/<label>.exit`.
  `--entry-path` stays the install-dir logical entry so `getDaemonLaunchIdentity` keeps comparing
  logical identity, exactly as the Windows relocation does with `forkEntryPath` versus `entryPath`.
  `--spawner-exec-path` becomes the clone executable, which is now the daemon's own responsible
  path.
- `EnvironmentVariables`: an explicit allow-list built by `buildDaemonLaunchdEnvironment(process.env)`:
  `ELECTRON_RUN_AS_NODE=1`, `ORCA_USER_DATA_PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH` (the
  hydrated launch PATH the app already carries after `hydrate-shell-path`), `TMPDIR`, `LANG` and
  `LC_*`, and every `ORCA_*` variable already set in the app process (`ORCA_DIAGNOSTICS_DISABLED`,
  `ORCA_DISABLE_MACOS_LOGIN_SHELL`, `ORCA_E2E_*`). Never the whole environment: the plist is a
  file on disk and the app's environment can hold tokens. The exact set is pinned by
  `pty-subprocess-env-inheritance.test.ts`, which already answers "which daemon process env reaches
  the spawned shell"; the allow-list must satisfy that test unchanged.
- `WorkingDirectory`: `userData` (same as today's `cwd: userDataPath`).
- `StandardErrorPath` and `StandardOutPath`: `<logs>/daemon-launch-<label>.stderr.log` and
  `.stdout.log`. This replaces the 8 KiB stderr tail capture in `launchDaemonChild`; the launcher
  reads the tail from the file on failure and deletes the files once the daemon is ready or the
  launch is settled.
- `RunAtLoad: true`, `KeepAlive: false` (launchd never restarts it; `DaemonRespawnThrottle` and
  the adapter's respawn own that decision), `AbandonProcessGroup: true` (launchd must not kill
  PTY children when the daemon exits; they are in their own sessions anyway), `ExitTimeOut: 10`
  (daemon-entry's own shutdown bound is 5 s), no `ProcessType` (the default class; `Background`
  would throttle terminal I/O), no `SessionCreate` (the daemon must stay in the user's login
  session for `login(1)` and the death watch).
- Not in the first pass: `SoftResourceLimits` with `NumberOfFiles`. Superset raises the daemon's
  fd limit because macOS's 256 soft default breaks PTY spawns under load (section 11, item 6),
  and launchd can set it declaratively. It is unrelated to TCC, so it waits for the measurement in
  section 10 and ships as its own change; the first plist carries only the keys above.

Bootstrap: `launchctl bootstrap gui/<uid> <plist>`. `uid` from `process.getuid()`. A non-zero exit
(no GUI domain when Electron was started over SSH, a malformed plist, domain overload) fails open
to `launchDaemonChild` with a telemetry reason. Before bootstrapping, prune dead labels (5.8).

Shutdown of a launched service (the `DaemonProcessHandle.shutdown` for a fresh launch, today
`terminateLaunchedDaemonChild`): `process.kill(pid, 'SIGTERM')` once the pid is known from hello,
wait up to 5 s, `SIGKILL`, then `launchctl bootout gui/<uid>/<label>` to drop the dead service and
delete the plist. Before the pid is known, `bootout` alone (launchd delivers SIGTERM then SIGKILL
after `ExitTimeOut`). The adopted-daemon handle (`createPreservedDaemonHandle`) is unchanged: it
uses the RPC `shutdown` through `cleanupDaemonForProtocol`, which is also what `restartDaemon`
uses. `launchctl` is never the primary kill path for a daemon that answers RPC.

### 5.3 Readiness without Node IPC

New module `src/main/daemon/daemon-launched-service.ts`, the launchd counterpart of
`daemon-launched-child.ts`, returning the same `{ identity, shutdown }` shape so
`createOutOfProcessLauncher` swaps one call for the other.

Protocol, bounded by the same 10 s the child launch uses today:

1. Poll every 100 ms. On each tick, first check the exit-reason file. If present, parse
   `{ reason, code }`: `occupied` maps to `DaemonEndpointUnavailableError('occupied')`, which the
   launcher already turns into adoption of the incumbent; anything else fails the launch with the
   stderr tail attached, as `fail()` does today.
2. Then try `DaemonClient.ensureConnectedWithin(remaining)` on the canonical socket and read
   `getDaemonIdentity()`. If `identity.launchNonce === ours`, the daemon is ready: the identity is
   `{ pid, startedAtMs, launchNonce }` from the hello (pid from the hello instead of `child.pid`),
   and `holdDaemonAdoptionLease(handle, socketPath, tokenPath, undefined, identity, pidPath)` runs
   unchanged. The nonce is a 122-bit UUID, so nonce equality is a stronger fence than
   `child.pid` was. A hello answering with a different nonce means an incumbent owns the endpoint;
   keep polling until our service writes `occupied` (its publish protocol will refuse the name) or
   the deadline passes, then adopt the incumbent, which is what the `occupied` path does today.
3. On timeout, `bootout` the label, attach the stderr tail, and throw. The daemon removes its own
   pid record on early exit today (`unlinkOwnedDaemonPidFile` in `fail()`); under launchd the daemon
   does that itself in `daemon-entry.ts` on every non-crash exit, and the launcher additionally
   calls `unlinkOwnedDaemonPidFile(pidPath, pidFromExitReason, launchNonce)` when the exit-reason
   file carries a pid.

Daemon side (`daemon-entry.ts`): `parseArgs` gains `hostGeneration`, `launchMechanism`,
`exitReasonFile`. When `process.send` is absent and `exitReasonFile` is set, the daemon writes
`{ reason: 'occupied' | 'startup-error' | 'shutdown' | 'idle' | 'login-session-dead', code, pid }`
to `<file>.tmp` and renames it into place on every exit path that already logs a reason
(`shutdown`, `onIdleShutdown`, `onRpcShutdown`, `onRetire`, and the `main().catch` branch). The
existing `process.send({type:'endpoint-unavailable'})` and `DAEMON_EXIT_ENDPOINT_OCCUPIED` stay for
the fork path. Readiness itself needs no new daemon code: the hello already carries the launch
nonce.

`launchctl print gui/<uid>/<label>` is read only to enrich the failure log with `last exit code`
and `pid`; its text format is not API-stable, so nothing decides on it.

### 5.4 Identity fields (Rule 1, additive)

Add optional `hostGeneration?: string` and `launchMechanism?: 'fork' | 'launchd'` to
`DaemonPidFile` (`daemon-spawner.ts`), `ParsedDaemonPid` (`daemon-pid-file-parse.ts`, `null` when
absent), `DaemonEndpointIdentity` (`daemon-hello-protocol.ts`), the hello response in
`daemon-client-connections.ts`, `DaemonStartOptions` (`daemon-main.ts`), and `DaemonServerOptions`.
Every reader treats absence as "old-style daemon". `readDaemonOwnerMetadata`
(`daemon-endpoint-adoption.ts`) must copy both onto a repaired record: the comment there already
records that dropping `appVersion` from a repaired record un-pins a Windows host directory, and
dropping `hostGeneration` would let pruning delete a live daemon's executable, which on macOS is
the poison itself.

### 5.5 Adoption and attribution health

`readVerifiedDaemonPid` and `inspectDaemonProcessIdentity` keep working under launchd:
`commandLineMatchesDaemon` looks for `daemon-entry`, the socket path, and the token path in the
`ps` command line, and the plist's `ProgramArguments` carry all three.

`getMacDaemonTccAttributionHealth` redefines nothing for old-style daemons. For a record with
`launchMechanism === 'launchd'` it reports `intact` when `spawnerExecPath` (the clone executable)
exists and the generation directory is pinned by that record, `severed` when the clone executable
is gone, `unknown` otherwise. Pinning makes `severed` unreachable in practice; the branch exists so
a pruning bug is visible in telemetry rather than silent. `unknown` still fails open everywhere.

`classifyDaemonSpawnerPath` (`src/shared/daemon-adoption-telemetry.ts`) gains a `daemon-host` class
for paths under `<userData>/daemon-host/`. Additive enum member.

### 5.6 Old-style daemon migration without killing live sessions

Preserve the current endpoint and adoption policy. A daemon without verified new-launch metadata
remains old-style; do not infer protection from its app version or an existing executable path.
When it has live sessions, or its inventory is unverifiable, retain it. New launch behavior takes
effect after natural retirement or an explicit user-authorized restart. Tell users that existing
affected sessions remain affected until restarted; do not promise immediate prevention for them.

Do not bump the protocol solely for this migration. Optional metadata follows the existing wire
compatibility contract. If an actual protocol change becomes necessary, use the normal reviewed
upgrade path and test every supported execution host. Immediate migration of fresh terminals
while retaining old sessions is a separate feature and is deferred.

The earlier protocol-bump proposal below is retained as a rejected alternative, not an
implementation requirement.

On the first launch of a Layer 2 build there is a running daemon forked by an older build from
`/Applications`, possibly poisoned, possibly holding sessions. It cannot be moved, it runs old code,
and it owns the canonical `daemon-v36.sock`. The endpoint protocol forbids taking that name while it
answers, and killing it violates the goal.

Mechanism: ship Layer 2 with `PROTOCOL_VERSION` 36 to 37 (`daemon-protocol-version.ts`). Then:

- The new app launches its daemon on `daemon-v37.sock` with the launchd path. No contention.
- `createLegacyDaemonAdapters` (`daemon-legacy-adapters.ts`) finds the v36 daemon through
  `PREVIOUS_DAEMON_PROTOCOL_VERSIONS`, wraps it in an attach-only `DaemonPtyAdapter`, and
  `DaemonPtyRouter` routes only its existing sessions to it. "Legacy adapters never respawn."
- The demoted daemon retires through the existing idle retirement (`DaemonServerLifecycle`,
  `beginIdleShutdown` and `retireAfterIdleReply`) when its last session exits.
- With zero live sessions, `prepareDaemonReplacement` never sees the v36 daemon at all; the v36
  endpoint is simply not the current one, and `cleanupDaemonForProtocol` for previous versions is
  what `restartDaemon` already does.

Why a protocol bump and not a darwin-only endpoint namespace: the bump path is the most exercised
supersede path in the product. This machine's runtime dir holds leftover sockets for v23, v26, v32,
v33, v34, v35 and v36, so the demote-and-drain behavior runs for real every few weeks on every
platform, and its tests exist (`daemon-pty-adapter-protocol-compatibility.test.ts`,
`daemon-pty-upgrade-adoption.test.ts`, `daemon-pty-router.test.ts`). A darwin-only namespace
(`daemon-v36-h.sock` plus a generalized legacy-endpoint enumerator) would avoid demoting Windows and
Linux daemons for a macOS reason, but it adds an untested discovery shape to the most
defect-prone area in the subsystem (`AGENTS.md`, twenty-three defects). The bump costs Windows and
Linux users one routine demote-and-drain; that is the trade taken. The wire itself only gains
optional fields; the bump is used for its adoption semantics, and the bump's changelog entry must
say so.

Sessions on the demoted daemon stay poisoned if they were. The Manage Sessions restart remains the
remedy for those, exactly as today.

### 5.7 Clone pinning and conservative pruning

Generalize `collectPinnedDaemonVersions` into `collectPinnedDaemonHostGenerations(runtimeDir)`:
read every `daemon-v<N>.pid`, keep the corrupt-record veto exactly as written (including the
`Number('') === 0` case), pin `hostGeneration` when present with the `inspectProcessLiveness`
verdict merged by `mergeProcessLivenessVerdict`, skip records without one (old-style daemons pin
nothing). The result type stays `PinnedDaemonVersionsEvidence` with `unverifiable` vetoing the whole
prune, as today.

`pruneOldDaemonHosts` gains a darwin branch over `<userData>/daemon-host`. A generation directory
is reclaimed only when all of the following hold:

- it is not the current generation;
- its verdict is positively `exited` (`reclaimUnownedDaemonHostDir` is reused unchanged; a missing
  record after a complete listing still counts as `exited`, as on Windows);
- its marker `completedAt` (or the directory mtime for marker-less staging leftovers) is older than
  one hour, which covers the window between publish and the daemon's own pid-record write and any
  concurrent materializer still staging;
- a `ps -axo comm=` listing (the same tool `daemon-process-identity-query.ts` already shells to)
  shows no process whose executable path starts with the directory. This last veto is belt and
  braces against a pid-record bug: on Windows a wrong prune fails the next launch open; on macOS it
  recreates the outage.

Never prune while the listing is `unverifiable`. Never prune a generation referenced by a legacy
protocol's record (the enumeration covers all `daemon-v*.pid`). Cap nothing: a machine that keeps
old generations because they are pinned is correct.

### 5.8 App quit, crash, update, reinstall, logout

- App quit: `disconnectDaemon()` (`daemon-provider-state.ts`) disconnects without killing. The
  launchd agent is launchd's child, not the app's, so it survives exactly as the detached fork did.
- App crash: same; nothing in launchd reacts to the app.
- Full shutdown (`shutdownDaemon`) and Manage Sessions restart (`restartDaemon`): RPC `shutdown`
  through `cleanupDaemonForProtocol`; the daemon exits; the transient service becomes a dead label
  that the next launch boots out (5.2). `restartDaemon` then calls `ensureRunning`, which
  materializes (idempotent, marker hit) and bootstraps a new label.
- Update: `performQuitAndInstall` (`updater-install-execution.ts`) calls `killAllPty()`, which
  covers in-process PTYs only, then Squirrel swaps the bundle and relaunches. The daemon is its own
  responsible process on a pinned clone, so the swap is invisible to tccd. On relaunch
  `isDaemonStaleForCurrentBundle` sees a different `appVersion`, `prepareDaemonReplacement`
  replaces at zero sessions (`stale_bundle`) or preserves with sessions. Preserving is now safe;
  the preserved daemon runs the old generation's code until it drains, which is the Windows
  contract too.
- Same-version reinstall: CDHash decides. Same build reuses the generation and the daemon is
  adopted or replaced by the ordinary rules; a different build with the same version string gets a
  new generation and the old one stays pinned while its daemon lives. No `rmSync(dest)` exists on
  this path, so the Windows "live daemon in this version's dir" fail-open case cannot occur.
- Logout or reboot: the `gui/<uid>` domain tears down its agents with SIGTERM then SIGKILL. Today's
  detached daemon is killed by loginwindow at logout as well, so this is not a regression, and the
  transient service does not come back at next login. `MacosLoginSessionDeathWatch` stays enabled
  for GUI launches for the residual case where the login session dies under a surviving process.
- Dead-label pruning runs at every launch before bootstrap: `launchctl print gui/<uid>` filtered to
  this runtime dir's label prefix; `bootout` only labels whose `launchctl print` shows no `pid`.
  A label with a pid is someone's live or starting daemon and is left alone.

### 5.9 Multi-profile and concurrent launches

- Profiles: `userData` differs per profile (`configure-process.ts`: `orca`, `orca-dev`, the e2e
  override, `--user-data-dir`), so runtime dir, clone root, socket names and labels are all
  distinct. Nothing is shared.
- Two instances of one profile: `acquireSingleInstanceLock` normally prevents it;
  `shouldBypassSingleInstanceLock` allows it in some darwin modes, so the design does not rely on
  it. Materialization races resolve on the `rename` (5.1). Launch races resolve on the endpoint
  protocol: the loser's daemon exits `occupied` and the loser adopts, as today. Labels are unique
  per nonce. Pruning is verdict-based and idempotent.
- A launch racing a Manage Sessions restart is serialized by `runCoalescedDaemonRestart` today and
  stays so.

### 5.10 Dev builds and headless hosts

- Packaged asar builds: on by default (subject to the kill switch).
- Dev (`pnpm dev`): off by default. `ORCA_MACOS_DAEMON_LAUNCH=launchd` opts in; the source bundle is
  `node_modules/electron/dist/Electron.app`, the entry stays the worktree's `out/main/daemon-entry.js`
  (not inside the clone), and the daemon still dies with the worktree through the existing
  `different_app_path` rule. Grants are per-cdhash for the ad-hoc identity, which is the status quo
  for dev.
- `orcad` and serve-mode Electron started without a GUI session: no asar, or `bootstrap` fails on a
  missing `gui/<uid>` domain. Both fail open to the fork path with a telemetry reason.
- e2e (`ORCA_BACKGROUND_LAUNCH=1`): the fork path remains available under the kill switch so
  existing daemon e2e keeps its shape; a dedicated launchd e2e is added (section 9).

### 5.11 Uninstall

macOS has no uninstaller. Dragging `Orca.app` to the Trash leaves `<userData>/daemon-host/<gen>`
holding real blocks once the source is gone (up to one bundle per pinned generation, 513 MB
today). The daemon exits on idle and at logout, and no persisted launchd service exists, so
nothing keeps running. The support "remove Orca completely" note must list
`~/Library/Application Support/Orca/daemon-host` (and the per-profile roots), and pruning keeps at
most the current plus pinned generations, so an uninstalled machine holds one after its daemon
exits and the user relaunches nothing. There is no reaper for the never-relaunched case, by design:
a sweeper that guesses is the defect class `AGENTS.md` retired.

### 5.12 Telemetry

All additive properties, bucketed where counts are involved:

- `daemon_adopted` (`trackDaemonAdopted`): add `launch_mechanism` (`fork` | `launchd` | `unknown`
  from the pid record) and reuse `spawner_path_class` with the new `daemon-host` member.
- New `daemon_launched` from `createOutOfProcessLauncher`: `launch_mechanism`, `host_clone`
  (`reused` | `materialized` | `fallback`), `fallback_reason` (`not-applicable` | `clone-failed` |
  `verify-failed` | `bootstrap-failed` | `readiness-timeout` | `kill-switch`), `readiness_bucket`
  (`<1s`, `1-3s`, `3-10s`, `timeout`).
- `daemon_pty_cwd_denied` (`trackDaemonPtyCwdDeniedIfDiverged`) unchanged; the rollout success
  criterion is that it goes to zero for `launch_mechanism = launchd` and stays flat for
  demoted legacy daemons until they drain.
- `daemon_lifecycle` `replaced` reasons unchanged; `DAEMON_REPLACE_REASONS` gains nothing.

### 5.13 Rollout and kill switch

- Build constant `MACOS_DAEMON_LAUNCH_DEFAULT = 'launchd'` for packaged darwin, overridden by
  `ORCA_MACOS_DAEMON_LAUNCH=fork|launchd`. `fork` restores today's path completely; the clone code
  never runs.
- Hourly channel first (it already notarizes so identities hold), then daily, then stable. Between
  channels: `daemon_launched.fallback_reason` distribution, `daemon_pty_cwd_denied` by mechanism,
  and the harness in CI (section 9) green on the release candidate.
- No migration-only protocol bump ships with this change; section 5.6 governs old-style adoption.
- Rollback: set the env default back to `fork`. Launchd-launched daemons already running are
  ordinary adoptable daemons to a fork-mode app (hello identity, pid record and command line all
  match), so rollback kills nothing.

### 5.14 Security and EDR posture

- The clone is a byte-identical, signature-valid copy of the notarized bundle under its own name in
  the user's Application Support, executed as Node. This is the same shape the Windows relocation
  settled on after the T1036 finding; the verbatim-name and PID-plus-command-line identity rules in
  `windows-daemon-host-relocation.md` apply unchanged.
- `launchctl bootstrap` of a plist is a Launch Agent persistence indicator (T1543.001). Mitigations:
  the plist lives in the app's private runtime dir, not `~/Library/LaunchAgents`; the service is
  transient and dies at logout; the label is namespaced under the bundle id; `KeepAlive` is false;
  the plist is deleted on bootout. Document this in a macOS analog of
  `docs/reference/windows-edr-posture.md`.
- No secrets in the plist: env allow-list only. The token stays in the 0600 token file.
- Quarantine is stripped only from our own clone, never from the source bundle.

## 6. Regression risks and mitigations

| Risk                                                                                                          | Where it would bite                                                                      | Mitigation                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pruning deletes a live daemon's clone, recreating the outage on the new path                                  | `pruneOldDaemonHosts` darwin branch; `readDaemonOwnerMetadata` dropping `hostGeneration` | Verdict-based reclaim only; one-hour floor; `ps` executable-path veto; unit test that a repaired record keeps `hostGeneration`; harness row that prunes under a live daemon and asserts the directory survives |
| launchd env differs from fork env and shells lose PATH, TMPDIR, or `ORCA_*`                                   | `buildDaemonLaunchdEnvironment`; `pty-subprocess-env-inheritance.test.ts`                | Allow-list derived from that test's expectations; e2e opens a terminal and asserts `echo $PATH` equals the fork-mode value                                                                                     |
| No `gui/<uid>` domain (SSH-started Electron, CI runners without a login session)                              | `bootstrapDaemonLaunchdAgent`                                                            | Fail open to fork with `fallback_reason = bootstrap-failed`; CI runners for the harness must be self-hosted with a logged-in session                                                                           |
| Dead labels accumulate or a live label is booted out                                                          | `bootoutDeadDaemonLaunchdAgents`                                                         | Only labels with no `pid` line; prefix filtered to this runtime dir; unit test on the `launchctl print` fixture; never bootout as a kill path for an RPC-reachable daemon                                      |
| Readiness poll adopts an incumbent that answers hello with another nonce before our daemon reports `occupied` | `daemon-launched-service.ts` step 2                                                      | Adoption of an incumbent is the existing `occupied` behavior; the identity fence compares the nonce so a wrong daemon is never leased as ours                                                                  |
| Protocol bump demotes Windows and Linux daemons for a macOS reason                                            | `PROTOCOL_VERSION` 37                                                                    | Routine path (seven versions of leftover sockets on this machine); changelog states the reason; no code change on those platforms                                                                              |
| Quarantined DMG install makes the clone exec trigger Gatekeeper                                               | 5.1 post-copy gate                                                                       | Strip on the clone; harness row with a quarantined source                                                                                                                                                      |
| Clone across volumes or on HFS+ costs a 500 MB copy on the launch path                                        | `cp -c` fallback                                                                         | Off first paint; size gate; telemetry `host_clone = materialized` with duration bucket; if slow in the field, defer materialization to after first window                                                      |
| Same-version reinstall of a different build reuses a generation                                               | Generation identity                                                                      | CDHash key; unit test with two fixtures of equal version and different CDHash                                                                                                                                  |
| `launchctl print` output format changes                                                                       | 5.3 diagnostics only                                                                     | Nothing decides on it; the exit-reason file is our own format                                                                                                                                                  |
| Rewriting a running clone kills the daemon with a code-signature fault                                        | Immutability                                                                             | No writer exists after publish; marker written in staging; unit test that materialize never opens a published generation for write                                                                             |
| Rollback to fork mode strands launchd daemons                                                                 | 5.13                                                                                     | They are ordinary adoptable daemons; e2e adopts a launchd daemon from fork mode                                                                                                                                |

## 7. Files and symbols to change

New: `src/main/daemon/macos-daemon-host-clone.ts` (+ test), `macos-daemon-launchd-agent.ts`
(+ test with `launchctl` fixtures), `daemon-launched-service.ts` (+ test),
`daemon-launch-exit-reason.ts` (writer used by `daemon-entry.ts`, reader used by the launcher),
`docs/reference/macos-daemon-tcc-attribution.md` (from the Layer 1 branch, updated to describe the
shipped mechanism), a macOS section in the EDR posture reference, and the harness under
`tests/tools/macos-daemon-tcc-e2e/` with a `workflow_dispatch` workflow.

Modified: `daemon-out-of-process-launcher.ts` (choose mechanism, pass clone paths),
`daemon-entry.ts` (`parseArgs`, exit-reason writes), `daemon-spawner.ts` (`DaemonPidFile`),
`daemon-pid-file-parse.ts`, `daemon-hello-protocol.ts`, `daemon-client-connections.ts`,
`daemon-main.ts`, `daemon-server-options.ts`, `daemon-endpoint-adoption.ts`
(`readDaemonOwnerMetadata`), `daemon-host-relocation.ts` (generation pins, darwin prune branch;
the Windows copy plan untouched), `daemon-tcc-attribution.ts`, `daemon-adoption-telemetry-event.ts`
and `src/shared/daemon-adoption-telemetry.ts`,
`src/shared/telemetry-events.ts` (new event and properties), `.gitignore` (whitelist the new
reference doc, as the Layer 1 branch did).

Untouched on purpose: `daemon-endpoint-ownership.ts`, `daemon-stale-kill.ts`,
`daemon-protocol-cleanup.ts`, `daemon-replacement-preflight.ts` decision order,
`daemon-legacy-adapters.ts`, `daemon-pty-router.ts`, `macos-tcc-login-shell.ts`,
`macos-login-session-death-watch.ts`.

## 8. Unit and integration tests that fail first

The candidate tests below run under `pnpm test` and verify lifecycle/implementation contracts.
They do not prove macOS permission behavior; section 9 supplies that evidence. Adapt these tests
to the mechanism actually selected instead of treating invocation of launchd as the outcome.

1. `daemon-out-of-process-launcher.test.ts`: with a darwin packaged environment mock and a
   materialized clone, the launcher invokes `launchDaemonService` with the clone executable and
   `--launch-mechanism launchd`, and never calls `launchDaemonChild`. Fails today because the
   launcher calls `launchDaemonChild` unconditionally off win32.
2. `macos-daemon-host-clone.test.ts`: generation id equals the CDHash from a stubbed `codesign`
   output; two fixtures with equal `CFBundleShortVersionString` and different CDHash yield two
   directories; marker is the last write; rename conflict adopts the winner; a published generation
   is never opened for write; quarantine is removed from the clone and untouched on the source.
   Fails today because `materializeRelocatedDaemonHost` returns `null` on darwin.
3. `daemon-pid-file-parse.test.ts` and `daemon-endpoint-adoption.test.ts`: round-trip
   `hostGeneration` and `launchMechanism`; a record repaired by `reconcileDaemonPidOwnership`
   keeps both. Fails today because the fields do not exist.
4. `daemon-host-relocation.test.ts` (darwin cases): a generation referenced by a live record is
   kept; by an `exited` record older than the floor is removed; by a record younger than the floor
   is kept; an `unverifiable` listing prunes nothing; a `ps` line whose executable is under the
   directory vetoes removal. Fails today because `pruneOldDaemonHosts` returns early off win32.
5. `daemon-launched-service.test.ts`: readiness resolves on a hello whose nonce matches; a hello
   with a foreign nonce followed by an `occupied` exit-reason file yields
   `DaemonEndpointUnavailableError('occupied')`; a timeout boots the label out and attaches the
   stderr tail. Fails today because the module does not exist.
6. `daemon-entry.test.ts`: with `--exit-reason-file` and no `process.send`, each exit path writes
   the file atomically; the fork path still sends `endpoint-unavailable` and exits 20.
7. `daemon-tcc-attribution.test.ts`: a `launchd` record with an existing clone executable is
   `intact`; with a missing one is `severed`; a record without `launchMechanism` keeps today's
   verdicts. The `severed` case fails today because the field does not exist.
8. `macos-daemon-launchd-agent.test.ts`: plist rendering snapshot (no secrets, allow-list only,
   `KeepAlive` false, `AbandonProcessGroup` true); dead-label pruning boots out only labels without
   a `pid` in a `launchctl print` fixture.
9. Cross-version wire (`tests/e2e/cross-version-wire`): stays green because every field is optional
   (Rule 1). A client that requires `hostGeneration` would redden the new-client-old-host pairing;
   none does.

## 9. Signed-build harness with negative controls

`tests/tools/macos-daemon-tcc-e2e/` plus `.github/workflows/macos-daemon-tcc-e2e.yml`
(`workflow_dispatch`, self-hosted macOS runner with a logged-in GUI session and a PPPC profile or
one-time manual grant of Documents access to `com.stablyai.orca`). Modeled on
`tests/tools/win-update-e2e` and the survival workflows listed in
`windows-daemon-host-relocation.md`.

Setup per run: two signed, notarized builds A and B of the same identity; an isolated
`--user-data-dir`; A installed at `/Applications/Orca.app`; the app launched with
`ORCA_BACKGROUND_LAUNCH=1` so no window is shown; one terminal created through the daemon; a shell
loop in it that runs `ls ~/Documents` every 50 ms and prints `DENIED` on failure; the app quit so
the daemon stands alone.

Namespace guard, first pass: the harness and any daemon e2e refuse to start unless the user-data
override is set and resolves to a directory other than every real profile (`orca`, `orca-dev`,
and the rest under Application Support). Superset added the same guard after tests reached the
real daemon namespace and killed live dev stacks and their agents' terminals (section 11, item 5);
on macOS a wrong prune against the real profile would recreate the outage this work removes.

Mutations, applied in order while the loop runs: (1) `mv` A out and B in, exactly Squirrel's swap;
(2) empty the parked copy of A; (3) delete `/Applications/Orca.app` outright; (4) relaunch B and
assert it adopts or demotes the daemon without killing the loop.

Rows (each with `login(1)` on and off via `ORCA_DISABLE_MACOS_LOGIN_SHELL`):

| Row | Launch                                                                            | Expected                                                                                                                                    | What a surprise means                                                                    |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| N0  | M0 fork from `/Applications` (`ORCA_MACOS_DAEMON_LAUNCH=fork`)                    | `DENIED` appears after (1) or (2)                                                                                                           | The negative control failed to reproduce; the harness is invalid and no other row counts |
| N1  | M1 direct fork from the clone (harness-only flag)                                 | `DENIED`                                                                                                                                    | The mechanism model is wrong; stop and re-measure before shipping                        |
| P2  | M2 launchd from clone (the product path)                                          | No `DENIED` through (4); pid unchanged; `daemon_pty_cwd_denied` not emitted                                                                 | Ship blocker                                                                             |
| N3  | M3 launchd from `/Applications`, no clone                                         | Attribution: unknown (section 9.1 saw no denial, with a non-reproducing control). PTY creation: `ENOENT` while the path is absent, measured | An attribution pass no longer removes the clone; PTY creation needs a stable path anyway |
| X4  | M4 disclaim helper from clone                                                     | Unknown                                                                                                                                     | A pass equal to P2 makes M4 the simpler follow-up; a fail closes the question            |
| Q5  | P2 with a DMG-installed, quarantined A                                            | No `DENIED`, no Gatekeeper dialog, daemon starts                                                                                            | A failure means the quarantine strip is insufficient                                     |
| L6  | P2, then Layer 2 build launches with an old-style daemon holding the loop session | Loop keeps running on the demoted daemon; a fresh terminal lands on the v37 daemon; the old daemon exits after the loop terminal is closed  |                                                                                          |
| R7  | P2, then `pruneOldDaemonHosts` forced while the daemon runs                       | Generation directory survives; after the daemon exits and the floor elapses it is removed                                                   |                                                                                          |
| K8  | P2, then relaunch with `ORCA_MACOS_DAEMON_LAUNCH=fork`                            | The launchd daemon is adopted; nothing killed                                                                                               |                                                                                          |

### 9.1 Local measurements, 2026-09-14 (macOS 26.5.1, installed notarized build, this user's grants)

Procedure, reproducible from a shell without a signed-build pipeline and without touching
`/Applications/Orca.app`: `cp -cR` the installed bundle into
`~/Library/Application Support/orca-tcc-probe/<row>/Orca.app` (same notarized identity, so the
user's existing grants apply), exec it once directly as Node, then `launchctl bootstrap gui/<uid>`
a transient plist (`RunAtLoad`, `KeepAlive` false, `AbandonProcessGroup` true,
`ELECTRON_RUN_AS_NODE=1`) running a script that every 250 ms reads `~/Documents` in-process and
through a fresh `/bin/ls` child, and every 2 s spawns `/bin/sh` through `node-pty` loaded from the
clone's own `Contents/Resources/node_modules/node-pty`. Phases while the loop runs: park the
bundle (`mv` to a sibling name, 12 s), restore it (6 s), delete it (`rm -rf`, 12 s). Bootout and
delete everything afterwards. The shell that ran it could read `~/Documents`, so the grant existed.

The procedure is checked in as a reusable tool at `tests/tools/macos-daemon-tcc-probe/` (`probe.mjs`
driver, `loop.cjs` in-clone loop). It is the harness the negative control in the acceptance list
below should be run with on a machine that reproduces the field denial:
`node tests/tools/macos-daemon-tcc-probe/probe.mjs --rows=CTL,M3,N0 [--login] [--no-pty] [--phases=swap:14,delete:14]`. Phases are `park`, `restore`, `delete`, `swap` (replace the bundle at the recorded path with a broken-seal build) and `swapok` (same motion, valid signature).

Rows run:

| Row           | Shape                                                                                                                                                      | Folder access (in-process and `ls` child) | PTY creation through `node-pty`                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| CTL (M2-like) | launchd from a clone that is never touched                                                                                                                 | 58 of 58 ok, no prompt                    | not exercised                                                                                                   |
| M3            | launchd from a clone whose path is parked, restored, deleted                                                                                               | ok on every tick in every phase; 0 denied | ok while the path exists; `posix_spawn failed: ENOENT` in park and delete (6 of 6 each), ok again after restore |
| N0 emulation  | launchd agent forks a detached child then exits, so the child's responsible process is dead and only its recorded path remains; same park, restore, delete | ok on every tick in every phase; 0 denied | same `ENOENT` pattern as M3                                                                                     |

What this settles and what it does not:

- **Grants apply to a clone under launchd.** No prompt, no denial, on a notarized build with the
  release identity. This was an assertion in the plan; it is now measured for this configuration.
- **The clone is load-bearing for PTY creation, measured.** `node-pty` execs `spawn-helper` from
  the bundle on every spawn, so any daemon whose bundle path is absent cannot create a terminal
  until the path returns. Today's production daemon has exactly this exposure during the Squirrel
  swap gap; a pinned clone removes it. This satisfies the decision update's condition for keeping
  a stable runtime independent of what attribution measures.
- **Attribution is not settled by this run.** M3 saw no denial, but the N0 emulation, which
  matches the reported mechanism (responsible process dead, path unresolvable, fresh evaluations
  every 250 ms for 12 s), saw none either. On this machine and grant configuration the reported
  mechanism did not reproduce, so the M3 result cannot distinguish "the clone is unnecessary for
  attribution" from "this environment never denies". Candidates that remain untested for the
  denial: a Full Disk Access grant versus a per-folder grant, OS version, and a cold `tccd` cache
  (the field reports needed hundreds of terminals over several updates). The Full Disk Access
  candidate was the strongest of these and has since been tested and eliminated; see section 9.2.
  The negative control in the acceptance list below stays mandatory.
- **The `login(1)` chain was tested and changed nothing.** Production shells wrap the child in
  `login -flpq <user>`, so the probe was rerun with the child read going through that wrapper. One
  run showed the only denial signal seen anywhere in this work: in the delete phase, M3's
  **in-process** `readdirSync` returned `EPERM` on 38 of 48 ticks while its `login(1)` child still
  read the folder on all 48, and N0 showed zero. Three repeat runs of the delete phase (two with
  `login(1)`, one without) returned zero in-process `EPERM` on both rows. It did not reproduce, and
  its direction is backwards for the reported mechanism: the denial landed on the row whose
  responsible process is **alive** and not on the row whose responsible process is dead with an
  unresolvable path. Recorded as unexplained single-run noise, not as evidence for or against any
  mechanism. It does not change the M2 recommendation, which rests on PTY-creation survival.
- **A fresh clone can fail to launch once.** Two of the first three launchd launches died in
  `dyld` with a framework dylib reported missing although it existed; a direct exec before
  bootstrap avoided it every time. Cause unknown; the 5.1 smoke-exec gate is the mitigation.
- **Expected stderr noise.** Every launchd-launched clone logged Electron's
  `codesign_util.cc: task_name_for_pid: (os/kern) failure (5)` once at startup and ran normally.
  The readiness path must not treat that line as a failure.

### 9.2 Second pass, 2026-09-14: Full Disk Access revoked, and an update emulated

Section 9.1 could not reproduce the denial and named the grant shape as the leading suspect. It
was. Reading the TCC databases showed the probe host had granted the app blanket access:

```
kTCCServiceSystemPolicyAllFiles|com.stablyai.orca|2          (system db)
kTCCServiceSystemPolicyAllFiles|com.stablyai.orca.helper|2   (system db)
kTCCServiceSystemPolicyDocumentsFolder|com.stablyai.orca|2   (user db)
```

Every section 9.1 row therefore ran with blanket file access, and the per-folder evaluation that
the field mechanism acts on was never on the critical path. The clone carries the release signing
identity, so it inherited that grant too.

Full Disk Access was revoked for the app by hand, leaving the per-folder Documents grant in place.
That is the field shape: a folder the user granted once, and no blanket access. Revocation was
confirmed by the side effect that reading the system TCC database, an operation that requires the
blanket grant, changed from succeeding to `authorization denied`, while `~/Documents` stayed
readable. `kTCCServiceSystemPolicyAllFiles` lives in the SIP-protected system database, so this
step cannot be scripted and needs a human at System Settings.

Runs, all against `~/Documents`, all with the source bundle untouched. `swap` replaces the bundle
at the recorded path with a different one carrying a broken seal, which is closer to what an update
does than 9.1's park-and-restore of the identical bundle; `swapok` is the same motion with a valid
signature and the same identity; `--no-pty` suppresses PTY spawns.

| Run | Configuration | M3 delete phase | N0 delete phase | CTL |
| --- | --- | --- | --- | --- |
| before | blanket access, park/restore/delete | 57 ok, 0 denied | 56 ok, 0 denied | clean |
| after | per-folder only, park/restore/delete | 56 ok, 0 denied | 56 ok, 0 denied | clean |
| swap 1 | per-folder only, broken seal, PTY on | **0 ok, 56 denied, 56 in-process EPERM** | 56 ok, 0 denied | clean |
| A | broken seal, PTY off | 57 ok, 0 denied | 55 ok, 0 denied | clean |
| B | valid seal, PTY off | 57 ok, 0 denied | 56 ok, 0 denied | clean |
| C | broken seal, PTY on (repeat of swap 1) | 56 ok, 0 denied | 56 ok, 0 denied | clean |
| D | valid seal, PTY on | 57 ok, 0 denied | 56 ok, 0 denied | clean |

- **Blanket access was a real confound and is now removed.** Section 9.1's rows cannot be read as
  evidence about per-folder attribution at all. The re-run under the corrected grant shape is the
  `after` row, and it still shows no denial anywhere, including the negative control.
- **The denial that appeared once is not attributable to TCC.** Run `swap 1` produced the only
  complete denial seen in this work: M3 lost both the in-process read and the `/bin/ls` child read
  for the whole delete phase. It also raised a Gatekeeper *"Orca.app is damaged and can't be
  opened"* dialog, because the probe launched `spawn-helper` out of the seal-broken bundle. Run C
  repeated that configuration exactly and was clean, and the PTY-off and valid-seal controls were
  clean. A denial that survives neither a repeat nor its own controls is an artifact of Gatekeeper
  handling a damaged bundle, not evidence about responsible-process attribution.
- **Two anomalies now share a shape.** The `login(1)` episode in 9.1 and `swap 1` here both landed
  on M3, both were single occurrences, and neither survived a repeat. M3 is the row whose
  responsible process is **alive**, which is backwards for the reported mechanism. Treat any future
  single-run denial on this harness as unproven until it repeats.
- **The reported mechanism still does not reproduce on this host.** macOS 26.5.1, notarized build,
  per-folder Documents grant, no blanket access, with the recorded path parked, deleted, replaced
  by an identical bundle, and replaced by a different and invalid bundle. The negative control
  never denied in any of them. This is a negative result about this host, not proof the field
  reports are wrong.
- **What is left to vary.** The field machine itself, a real Squirrel update on an isolated test
  host rather than an emulated bundle swap, an older macOS, and a cold `tccd` cache. The field
  reports needed hundreds of terminals across several updates to surface, which no single probe
  session reproduces.
- **Unchanged by all of this:** the PTY-creation result. Every row in every run failed
  `posix_spawn` while the bundle path was absent and recovered when it returned. That is the
  measured, repeatable failure the pinned clone fixes, and it is what the M2 recommendation rests
  on. None of the attribution ambiguity above weakens it.

### Required acceptance before choosing and shipping the mechanism

- Run destructive update simulations only on an isolated macOS test host or VM, never against
  the user's installed `/Applications/Orca.app`. Preserve background-launch policy. Use fixture
  files in protected folders rather than enumerating personal contents.
- Establish baseline access, then reproduce persistent denial on the old product launch path
  after the source app path has been restored. Hold the swap gap long enough to exercise it
  deterministically, then also test real Squirrel updates. A non-reproducing control is
  inconclusive, not a pass. Record OS versions and all grants; broad runner permission must not
  mask the control.
- For each candidate, capture daemon/shell/agent PID plus start identity before the update.
  Assert those same processes remain alive and usable after two updates, parked-bundle cleanup,
  GUI quit, and GUI relaunch. The same established terminal must repeatedly read/write its
  protected-folder fixture and successfully spawn a child afterward. Restored scrollback,
  resumed agent conversations, demotion to another daemon, or a fresh terminal is not a pass.
- From the same surviving terminal, after each update and relaunch, `security verify-cert` on a
  known-good system certificate must exit 0. This is the trustd reachability probe Superset uses
  (section 11, item 1): a daemon spawned by an updater-relaunched app can inherit a Mach bootstrap
  that cannot reach trustd, which breaks `gh` and TLS in every terminal. It is a second
  inherited-context axis, independent of TCC, and costs one command per assertion, so it is in the
  first pass. A candidate that preserves folder access but fails this is not a pass.
- Exercise a terminal initially outside protected folders that first enters one after updating,
  plus terminals already using Documents, Desktop, and Downloads. Test new terminal creation as
  an additional check, not a substitute. Deliberate app deletion is a separate isolated stress
  test; restore build B before testing relaunch.
- Test existing grants, absent grants, and revocation. The fix must preserve expected access and
  expected denials. Do not infer grant compatibility from the bundle identifier alone. Compare
  login wrapping enabled/disabled and the supported macOS versions chosen for release coverage.
- Repeat the reproducing control and winning candidate at least three times per selected test
  configuration. Archive scripts and evidence so another engineer can reproduce the conclusion.
- Verify startup failure/timeout, concurrent launch, environment inheritance, clone ownership
  and pruning, rollback, and natural retirement. No fallback may launch a second owner until the
  first launch is confirmed settled. Ordinary denial and fallback launches are not counted as
  successful prevention.

Unit tests in section 8 verify implementation contracts; mocks and calls to the expected launcher
do not establish TCC correctness. Telemetry is supporting rollout evidence, not causal proof:
the current cwd-denial event misses old daemons and later protected-folder access. Report coverage
and fallback rates, and investigate regressions even if that event count is zero.

## 10. Open questions that only measurement answers

- N3, narrowed by section 9.1: the clone is needed for PTY creation regardless of attribution.
  Still open is whether attribution alone would survive without it, which only matters if a
  cheaper stable runtime than a bundle clone (for example, just `node-pty` and its
  `spawn-helper`) were ever proposed. First find a configuration that reproduces the denial.
- X4: does `responsibility_spawnattrs_setdisclaim` make a `posix_spawn`ed daemon its own responsible
  process in tccd's eyes, and can the Node IPC channel fd pass through the helper so readiness
  needs no new protocol?
- Materialization cost off APFS or across volumes in the field (telemetry `host_clone` duration).
- Whether `launchd`'s `gui/<uid>` domain is present for every way Orca is launched on a desktop
  (Dock, `open`, Spotlight, the `orca` CLI, login items). The fail-open covers absence; the
  telemetry says how often it happens.
- Whether a surviving terminal's Mach exception ports (section 11, item 2) differ between a
  fork-spawned and a launchd-spawned daemon after an updater relaunch, and whether Orca's daemon
  inherits the app's crash handler today. Later pass; the trustd axis is already in the acceptance
  list.
- What `ulimit -n` a daemon-hosted shell sees today (section 11, item 6). Later pass; it decides
  whether the fd-limit plist key ships as a follow-up.

## 11. Prior art: Superset's pty-daemon supervisor

Read 2026-09-14 from a sibling checkout (`packages/host-service/src/daemon/DaemonSupervisor.ts`,
`packages/pty-daemon/src/{main.ts,Server/Server.ts,Pty/Pty.ts,trustd-probe.ts}`,
`apps/desktop/src/main/lib/host-service-coordinator.ts`, `apps/desktop/docs/HOST_SERVICE_BOUNDARIES.md`,
`plans/v2-terminal-env-handoff.md`). Superset runs the same shape as Orca: an Electron app spawns a
detached Node daemon that owns PTYs and survives app restarts.

What Superset does not do: no launchd, no bundle clone, and no TCC attribution handling anywhere
in the tree (no `tcc`, `responsib`, or Full Disk Access references). Its daemon is spawned
detached from the host-service's `process.execPath` through `/bin/sh -c 'ulimit -n …; exec "$@"'`,
which is Orca's M0 shape. So it offers no measurement for sections 4 or 9. If Superset updates
through Squirrel.Mac the same failure is latent there; nothing in the tree says whether they have
seen it, which is a question to ask them, not evidence.

What is worth borrowing, and what is not. Pass allocation: items 1, 3, 5, 7 and 8 are in the
first pass (each is either an acceptance assertion, a guard, or a check that shapes the launch
spec); items 2 and 6 are later passes; item 4 is out of scope; item 9 changes nothing.

1. **A sibling inherited-context failure, handled the way Orca's rules require.** `trustd-probe.ts`
   runs `security verify-cert` against a known-good system cert from inside the daemon, after
   bind, and self-reports the bit in the hello-ack. Its comment names "updater relaunch" and "a
   dead login-session port after logout/login" as causes of a Mach bootstrap that cannot reach
   `com.apple.trustd`, which makes `gh` fail with `x509: OSStatus -26276` in every daemon terminal.
   The supervisor respawns only when the supervisor's own bootstrap is healthy, an inconclusive
   probe fails open, and the value fills once and never triggers a mid-life kill. Orca has the
   analogous `unhealthy_resolver` replace reason (`getMacDaemonSystemResolverHealth`). Two
   takeaways: an updater-relaunched app hands its daemon a degraded bootstrap and a launchd agent
   gets its bootstrap from the `gui/<uid>` domain instead, so the acceptance list in section 9
   asserts trustd reachability from the surviving terminal on every candidate (first pass); and a
   self-reported context bit on the hello is the same additive shape as `hostGeneration` and
   `launchMechanism` (5.4), which stays a later pass because the harness measures it directly.
2. **Inherited Mach exception ports.** `crashPortClearingLauncher` spawns the host-service through
   node-pty's patched `spawn-helper`, which clears the Crashpad exception ports before exec so the
   whole subtree (git, hooks, login shells, agent CLIs) stops uploading crashes as the app's
   minidumps. Relevant twice. Everything a forked daemon inherits from the app is part of its
   lineage, and launchd-spawn does not inherit the app's ports while M1 and M4 do unless the
   helper clears them. And a tiny native launcher in the node-pty tree, built and signed with
   `pty.node`, is a shipped precedent for the X4 helper shape. Whether Orca's daemon inherits the
   app's crash handler today is unchecked.
3. **Readiness without Node IPC, as 5.3 proposes.** `waitForSocket` polls connectability (5 s),
   the failure path attaches a 2000-byte tail of the daemon's rotating log file, an early
   `child.once('exit')` captures the exit code and signal, and after readiness spawned and
   adopted daemons are treated identically ("a PID to check, a socket to connect to, a secret").
   Orca's `daemon-file-log` already exists; the exit-reason file in 5.3 is the launchd substitute
   for the early-exit capture.
4. **fd-handoff daemon upgrade, and why it does not meet the decision update.** `prepareUpgrade`
   spawns a successor with every live PTY master fd in its stdio array plus a snapshot file, waits
   for an IPC ack, and exits; the successor rebuilds sessions with `adoptFromFd` (a custom
   `AdoptedPty` that reaches into node-pty's private `_fd`, version-pinned) and binds with a retry
   on `EADDRINUSE`. Shell PIDs survive a daemon binary swap. It does not help the priority in the
   decision update: the successor is spawned by the predecessor, so under mechanism 1 it keeps the
   predecessor's responsible process, and the surviving shells keep their own lineage whatever the
   daemon does. It also has no counterpart in Orca's endpoint ownership protocol (the successor
   takes the name after the predecessor unlinks it, which `AGENTS.md` forbids). Keep it out of
   scope; it is a possible future answer to "upgrade daemon code without demotion", not to TCC.
5. **Test namespace guard.** `assertIsolatedDaemonNamespaceInTests` makes every daemon-layer test
   throw unless the home dir is an isolated temp dir, after tests killed live dev stacks and their
   agents' terminals. First pass: the section 9 harness and any daemon e2e refuse to run unless
   the `--user-data-dir` override is set and differs from the real profile directories.
6. **File descriptor limit.** Superset raises `ulimit -n` to the hard limit in a `/bin/sh` wrapper
   before exec because macOS's 256 soft default starves a daemon hosting many worktrees' PTYs and
   surfaces as node-pty `posix_spawnp failed` (EMFILE). Orca only maps EMFILE to a hint
   (`node-pty-error-hints.ts`). Under launchd this is a plist key (`SoftResourceLimits` with
   `NumberOfFiles`); on the fork fallback it is the same wrapper. Later pass: unrelated to TCC,
   so it follows the measurement in section 10 as its own change (noted in 5.2).
7. **Terminal env derived from the user's shell, not inherited.** Superset's v2 plan replaces
   spreading `process.env` into PTYs with a base env captured from a login shell at host-service
   startup and stripped of runtime variables (`resolveTerminalBaseEnv`, `initTerminalBaseEnv`).
   If Orca's PTY env is likewise shell-derived inside the daemon, the launchd allow-list in 5.2
   shrinks to the daemon's own runtime variables; `pty-subprocess-env-inheritance.test.ts` is the
   place to confirm which it is before the allow-list is fixed.
8. **Mode flags travel on argv, never env.** Superset's `--handoff` comment records that Bun and
   esbuild constant-fold `process.env.KEY` at bundle time, including bracket access. electron-vite
   bundles `daemon-entry.js` the same way, which is one more reason `--launch-mechanism` and
   `--exit-reason-file` are arguments in 5.3.
9. **Adoption safety rules match Orca's.** Never signal a pid you cannot prove is your daemon,
   `EPERM` on `kill(pid, 0)` means alive, a silent-but-accepting socket gets an escalated probe
   budget rather than a fresh spawn, and spawning over a live socket is logged as a hazard
   (`pty_daemon_spawn_over_live_socket`). Nothing to change; the overlap is confirmation.

## 12. Investigation session 2026-09-19: M6 evaluated, mechanism still unconfirmed

This section records a full investigation that (a) evaluated a new candidate, **M6**, a tiny
launchd-spawned "responsibility anchor"; (b) gathered the responsible-process and TCC-identity
mechanism from XNU/CoreFoundation source, Apple documentation, and `tccd` binary inspection; (c)
ran the clone probe with a `tccd`-restart phase; and (d) surveyed open-source precedent. **The net
result is that the design remains inconclusive** (see the status banner): the denial was not
reproduced, and the strongest field evidence points at a mode no relocation fixes.

Every claim below is tagged **[measured]** (observed this session), **[Apple]** (Apple docs, man
pages, XNU/CF source, or DTS staff posts), or **[inferred]**.

### 12.1 M6, the candidate evaluated

Instead of making the Electron daemon its own responsible process (M2, which forces the 513 MB
whole-bundle clone), M6 ships a **tiny native helper inside a minimal bundle** whose `Info.plist`
declares `CFBundleIdentifier com.stablyai.orca`, signed with the same Developer ID + team
(`6CX3WHS9HZ`). Only that kilobyte-scale bundle is copied to a stable `.noindex` path under
userData, one copy per anchor CDHash, never pruned. It is launched via `launchctl bootstrap
gui/<uid>` so it is its **own** responsible process, then it **forks the Electron daemon from the
installed `/Applications/Orca.app`** with today's argv and stays alive as a supervisor for the
daemon's lifetime. Every shell inherits the anchor as responsible process. The daemon still runs
Electron code from `/Applications`, which is what a preserved daemon does today, so that is not a
regression.

Supervisor contract, if M6 is ever built: `posix_spawn` (no disclaim — the daemon must *inherit*
the anchor), `POSIX_SPAWN_SETSID` + `POSIX_SPAWN_CLOEXEC_DEFAULT`, a lifeline pipe on fd 3 whose
EOF tells the daemon the anchor died, signal forwarding, an exit-reason file written create-exclusive
so the daemon's own reason wins, and no held stdio. It reuses the `signMacStandaloneHelper` path in
`config/electron-builder.config.cjs`. ~60 lines of C. This contract was designed but **not built**;
no signed anchor artifact exists.

### 12.2 Responsible-process mechanism (M6's and M2's shared foundation)

- **[Apple]** At `fork`, the child unconditionally inherits the parent's responsible pid:
  `proc_set_responsible_pid(child_proc, parent_proc->p_responsible_pid)` — XNU
  `bsd/kern/kern_fork.c:1045`, reached for `PROC_CREATE_FORK`, `PROC_CREATE_SPAWN`, and the
  exec-copy path, gated on no flag. The setter also records the responsible executable's UUID
  (`bsd/kern/kern_proc.c:5065`).
- **[Apple]** `exec` preserves it: `bsd/kern/kern_exec.c` never assigns `p_responsible_pid`.
  `bsd/sys/spawn.h` has **no** disclaim flag; the disclaim reset lives in the closed-source
  Quarantine MAC policy and is reached only through the private
  `responsibility_spawnattrs_setdisclaim(attrs, 1)` SPI. launchd applies that disclaim on behalf
  of the jobs it spawns, which is *why* a `launchctl bootstrap` job is its own responsible process.
- **[Apple]** `login(1)` preserves responsibility across its setuid exec. `/usr/bin/login` is
  `-r-sr-xr-x root wheel` **[measured]**, and Terminal.app's shells (spawned via `login -pf`) stay
  attributed to Terminal (Quinn, DTS thread 760964; themittenmac; Lapcat). Orca wraps shells in
  `login -flpq` (`src/main/providers/macos-tcc-login-shell.ts`), so the anchor→daemon→`login`→shell
  chain preserves the anchor as responsible process. This is the precedent M6 leans on.
- **[measured]** The libquarantine SPI `responsibility_get_pid_responsible_for_pid` returns the
  *queried* pid for every process on this host, including a child of a live parent, so it is
  **unusable** as an on-device oracle here.
- **[measured]** The unprivileged oracle that *does* work: `launchctl print pid/<pid>` prints the
  process's **resource coalition**, whose `name` is the launchd label or bundle id that rooted the
  tree — the same attribution TCC charges. `launchctl procinfo <pid>` names it outright but needs
  root. (Documented and tested by the `felt`/`shuttle` project,
  `cmd/shuttle_tmux_origin.go`.) The design doc previously knew only the root-only `procinfo`.

### 12.3 TCC identity resolution and grant carry-over

- **[measured]** `tccd`'s imports and strings show it resolves identity from the **audit token**,
  not LaunchServices registration: `responsibility_get_attribution_for_audittoken`,
  `responsibility_identity_get_binary_path`, `SecCodeCopyGuestWithAttributes`,
  `SecCodeCopyDesignatedRequirement`, plus `BUNDLE_ATTRIBUTION:` log strings and an identity cache
  keyed `cacheAccessIdentity:forAccessorAuditToken:responsibleAuditToken:isSpecificIdentity:`. It
  also imports `_LSCopyApplicationURLsForBundleIdentifier` and `_CFBundleCopyBundleURLForExecutableURL`
  / `_CFBundleURLLooksLikeBundle`, and carries a `"Responsible process's path is nil"` diagnostic.
- **[Apple]** The persisted grant's `csreq` is a Developer ID **designated requirement** =
  `identifier "com.stablyai.orca" and anchor apple generic and … certificate leaf[subject.OU] =
  "6CX3WHS9HZ"` (TN3127). It pins the **code-signing identifier + team**, not a CDHash, so a second
  binary with the same signing identifier and team satisfies the same row. A *different* identifier
  (e.g. `com.stablyai.orca.daemon-anchor`) would **not** match and would prompt separately, unless
  the launchd agent is attributed to Orca via `AssociatedBundleIdentifiers` (Quinn, DTS threads
  731504 / 732291 — that key's TCC-attribution use is DTS guidance, not the man page).
- **[measured]** `CFBundle` bundle-detection (`CFBundle_Executable.c`
  `_CFBundleCopyBundleURLForExecutablePath`, `CFBundle_Resources.c` `_CFBundleGetBundleVersionForURL`)
  strips the executable name / `MacOS` / `Contents` by string and requires a `Contents` (or
  `Resources`) directory — **no `.app` extension check**. So a minimal `Foo.bundle/Contents/{Info.plist,
  MacOS/foo}` should present as a bundle-type client.
- **[measured, forked harness]** An ad-hoc-signed minimal `Anchor.bundle` (`BNDL`) and `Anchor.app`
  (`APPL`) both read as **bundle-type** (`staticCode type 0`), and their forked child — including
  through `login -flpq` — is attributed to them. A bare Mach-O with an embedded `__info_plist`
  section is **path-type** (`type 1`). This is M6's fastest-kill test, and it **passed** on identity
  shape — but with ad-hoc throwaway identifiers and FDA-only, so it settles bundle-type attribution
  **not** grant carry-over.
- **[measured, this session's probe run]** A **dead-app clone lineage** (clone at a scratch path,
  parent exited, C child reparented to launchd, clone `rm -rf`'d) made a `kTCCServiceDeveloperTool`
  consult that `tccd` attributed to `responsible=com.stablyai.orca
  rpath=/Applications/Orca.app/Contents/MacOS/Orca` — the **canonical installed path, not the
  clone's real or deleted path**. This confirms `tccd` resolves the responsible path from the bundle
  identifier back to the installed app (via `_LSCopyApplicationURLsForBundleIdentifier`), rather than
  reading the running binary's vnode. It reconciles the forked session's two earlier observations:
  the production daemon keeps `/Applications` because its identity is bundle-id-registered, while a
  raw launchd-label lineage followed its parked path because it had no such registration.
- **[measured]** Orca **already ships** nested code carrying `com.stablyai.orca`:
  `orca-notification-status` (`config/scripts/build-notification-status-macos.mjs:31,55-63` embeds
  the identifier; `electron-builder.config.cjs:530-537` places it in `Contents/MacOS`), signed
  `--options runtime --timestamp` and verified `--strict`. So a same-identifier nested bundle is not
  new for Orca and is not rejected by `codesign`/notarization; App Store Connect's uniqueness rule
  (ITMS-90806) does not apply to Developer ID. **[Apple]** Correct home for a nested helper bundle is
  `Contents/Helpers/` or `Contents/Library/…`, never `Contents/Resources/` (Placing Content in a
  Bundle; code in Resources is the documented xattr-stripping notarization failure).
- **[measured]** `.noindex` does **not** keep a bundle out of LaunchServices: this host's
  `lsregister -dump` lists many bundles under `*.noindex` directories (App Store placeholders,
  `node-notifier`'s `terminal-notifier.app`, and an Orca recovery bundle). `.noindex` is a Spotlight
  exclusion only. What actually keeps M6's anchor out of `open -a Orca` resolution is the non-`.app`
  `BNDL` package type and launch-by-path, not the `.noindex` suffix. This corrects an inference the
  M6 sketch had relied on.
- **[Apple]** launchd caveat for M6/M2: an unset `ProcessType` applies **light CPU/IO throttling**
  (`launchd.plist(5)`), contradicting section 5.2's assumption; measure a daemon build under load
  and consider `Interactive`.

### 12.4 The two failure modes, now separated

The investigation's central clarification. The design conflated two failures:

1. **Path-unresolvable re-evaluation** (what this document assumes). A TCC check lands during the
   Squirrel swap gap while the responsible path cannot be resolved. **M2/M6 fix it, M3 does not.**
   Status: **not reproduced** in any session.
2. **Tahoe kernel-cache poisoning** (what field evidence matches). **[measured, forked harness]**
   The kernel caches the verdict per responsible lineage; the cache **survives the responsible
   process's death and its binary's deletion** — an N0-shaped C child that made its first
   `~/Documents` read 8 s after the clone was `rm -rf`'d read 80 times with **zero `tccd`
   consultation**, and a reinstall changed nothing. Electron's own startup always warms that cache,
   so no probe lineage reaches `tccd` cold without a flush. In this mode the responsible path never
   moves, so **M2, M3, and M6 all change nothing**; the fix is detect + `tccutil reset
   SystemPolicyDocumentsFolder com.stablyai.orca`, which belongs in the **recovery** design.

   Field corroboration: `anthropics/claude-code#91118` was filed from **Orca 1.4.155 on 26.5.1**
   and traces the denial to a kernel Sandbox verdict served from cache while `TCC.db` still reads
   `authValue=2`, `tccd` never consulted; onset followed a `TCCDEvent: type=Create, service=
   kTCCServiceSystemPolicyAppData, identifier=com.stablyai.orca` during an XProtect sweep. The
   denials appear **only** under `sender == "Sandbox" AND eventMessage CONTAINS "System Policy"`,
   not under the TCC subsystem; a fresh write into the folder succeeds because of the per-file
   `com.apple.macl` xattr; `tccutil reset` + a touch recovers **instantly, no restart**. Matching
   reports with jetsam/memory-pressure correlation: `#58952`, `ghostty#12947`, `cmux#2866`.

### 12.5 What was measured this session, and the confounds

- **[measured]** Both available hosts (26.5.1, build 25F80) had **Full Disk Access granted** to
  `com.stablyai.orca` (system-DB `kTCCServiceSystemPolicyAllFiles = 2`, plus `.helper`), which
  short-circuits every per-folder evaluation. This is section 9.2's confound, recurring. Every clean
  read is therefore meaningless for attribution. Removing FDA needs a human in System Settings (the
  grant is in the SIP-protected system DB) and would risk the live working session, since the
  project lives under `~/Documents`.
- **[measured]** The `tccd`-restart lever is **SIP-blocked**: `launchctl kickstart -k
  gui/<uid>/com.apple.tccd` returns `status=150: Operation not permitted while System Integrity
  Protection is engaged`. The field recoveries used `sudo pkill -9 -x tccd`, a different mechanism.
  So the decisive cold-`tccd` re-derivation test **cannot run on a SIP-on host** via kickstart; the
  probe run left `tccd` unperturbed (pids identical before/after).
- **[measured]** 14 days of Sandbox System Policy logs on this host show **zero** denials, and the
  N0 negative control has **never reproduced** the denial on any host available here.
- The probe tool now lives (in the harness worktree) at
  `tests/tools/macos-daemon-tcc-probe/` with `probe.mjs` (rows `CTL`/`M3`/`N0`/`N0C`, phases
  `park`/`restore`/`swap`/`swapok`/`delete`/`reinstall`/`sleep`/`tccd-restart`, `--first-read-delay`,
  `--root-base`), `tccd-attribution-log.mjs` (reads `AUTHREQ_CTX`/`ATTRIBUTION`/`RESULT` joined on
  `msgID` plus Sandbox denials), and compiled accessors `probe-ls.c`/`probe-loop.c`.

### 12.6 Open-source precedent — nobody ships M6

- **[measured]** *Disclaim at spawn* (M4-shaped) is shipped by **iTerm2**
  (`responsibility_spawnattrs_setdisclaim(attrs, 1)` at `iTermPosixTTYReplacements.c:442`, gated by
  the `disclaimChildren` advanced setting, default off), **raum** (opt-in, disclaims the tmux server
  birth), **Deno** (`cli/tools/desktop.rs`), and **Chromium** (`base/process/launch_mac.cc`).
  **Electron exposes no API for it.**
- **[measured]** *Relocating the executable off the update path* is shipped by **iTerm2** (copies
  `iTermServer` per version into `~/Library/Application Support/iTerm2/`, launched by a single fork
  that is deliberately **not** daemonized, so iTerm2 stays the responsible parent) and **Chrome**
  (`code_sign_clone_manager` hard-links a bundle clone at startup, `.bundle` extension "to avoid
  Launch Services issues").
- **[measured]** *Nothing* ships M6's exact shape — a tiny launchd-bootstrapped bundle that forks
  the real daemon and stays alive purely as its TCC anchor. The parts are precedented; the
  combination is not. This is a real maintenance-risk flag: novel behavior on private SPIs and
  undocumented responsible-process semantics, which Apple has changed across releases (11.4, Tahoe).
- **[measured]** launchd-hosted terminal daemons that hit exactly Orca's problem and chose *not* to
  relocate: **felt/shuttle** forbids its daemon from ever forking the tmux server; **kosmos** hosts
  tmux from a LaunchAgent with `AssociatedBundleIdentifiers` and still gets per-prompt drips;
  **termio** lists "daemon becomes its own responsible process" as an untested risk; **tortie**
  concludes the app itself should spawn the server and bundle a pinned binary; **agterm** documents
  the "started by an app that has since exited, so every command answers as its own responsible
  process" symptom directly.

### 12.7 The A1 grant-carry-over test — designed, not run

The one test that would settle M6's *grant carry-over* (as opposed to bundle-type shape, already
passed): a **Developer-ID-signed** anchor carrying `com.stablyai.orca` against a **per-folder**
Documents grant with **FDA off**, asserting (a) the forked child reads Documents via the per-folder
grant, and (b) the app's own TCC row does **not** land in `tccd`'s `expired` table. This needs the
signed anchor artifact, which **does not exist** — the harness identity test used ad-hoc identifiers.
Building it is the prerequisite for measuring M6 at all rather than only M2-vs-N0.

### 12.8 Isolated-host reproduction runbook (the real next step)

Reproducing the denial with **FDA off** is the single measurement that unblocks every decision.
Best host: a **Tahoe VM you can snapshot** (Apple Silicon, `tart`/UTM; Quinn's DTS advice is to test
TCC on a clean VM restored from snapshot), with a real GUI login session (TCC prompts and the
`gui/<uid>` bootstrap domain both require it). A spare physical Mac is higher fidelity for the
jetsam trigger; a second user account on the daily driver is **not** isolated enough for the
destructive steps.

1. Install two signed, notarized builds A and B (same identity); A at `/Applications`.
2. Set the field grant shape: launch A, read a `~/Documents` fixture, **Allow** once; then verify
   `SystemPolicyDocumentsFolder = 2` present and **no** `SystemPolicyAllFiles` row for Orca. Remove
   FDA in System Settings if present.
3. **Gate — establish N0 first.** Run today's fork path
   (`ORCA_MACOS_DAEMON_LAUNCH=fork`), loop a Documents-fixture read in a terminal, then `mv` A out /
   B in, empty the parked copy, and hold the gap. **A denial must appear.** If N0 never denies, the
   host does not reproduce and no other row counts (this is exactly what 9.1/9.2 failed to achieve).
4. If the plain swap does not deny, add the field triggers: `memory_pressure -l critical` to provoke
   jetsam sweeps, and `sudo pkill -9 -x tccd` to force the flush (**not** `launchctl kickstart` —
   SIP-blocked; only disable SIP with `csrutil disable` on the throwaway VM if the kickstart lever is
   wanted).
5. Capture per row: `/usr/bin/log show --predicate 'sender == "Sandbox" AND eventMessage CONTAINS
   "System Policy" AND eventMessage CONTAINS "deny"'`, `xattr -l ~/Documents` (the `com.apple.macl`
   presence gate), and `launchctl print pid/<pid>` (resource-coalition attribution).
6. Read the result as a decision: N0 denies **and** M2 (stable path) also denies under the same
   trigger → poisoning, no relocation helps, fix goes to the recovery design. N0/M3 deny but M2/M6
   survive → path-unresolvable mode, relocation helps. Nothing denies even with both triggers → the
   field condition is narrower than the VM reproduces; use the field machine or a long soak.

### 12.9 Revised recommendation

1. **Do not build M6 (or M2/M3/M4) on the strength of this document.** The premise is unconfirmed
   and the field signature currently matches a mode none of them fix.
2. **The next step is a reproduction on an isolated host with FDA off (12.8), gated on N0.** That one
   measurement decides whether any relocation helps at all.
3. **If a relocation is genuinely needed, M2 is the lower-novelty choice** despite the 513 MB clone,
   because "relocate the running executable off the update path" is what iTerm2 and Chrome already
   ship in production. M6's only advantage over M2 is deleting the clone; its cost is the one part
   nobody validates (the forking launchd anchor).
4. **If the failure is the Tahoe cache poisoning, none of this ships** — the work moves to the
   recovery design as detect + `tccutil reset`.
5. **The PTY-survival fact stands regardless** (section 9.1): `spawn-helper` cannot exec while the
   bundle path is absent, so some stable runtime is needed even if attribution needs no clone. That
   is the only load-bearing conclusion this whole line of work has firmly established.
