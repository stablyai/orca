# Windows Terminal Update-Survival: Design Plan

Companion to
[`windows-terminal-update-survival-postmortem.md`](./windows-terminal-update-survival-postmortem.md).
That doc records why the July 2026 attempt (#7421→#7499) was fully reverted
(#7505). This doc is the from-scratch plan for doing it right.

## Definition of done

1. **Terminals survive app auto-updates on Windows** — the same live shell
   processes, not a reconstruction.
2. **Surviving terminals are fully interactive** — typed input echoes, Ctrl+C
   works, resize works (the rc.2-era "frozen input" class is fixed and
   regression-tested).
3. **No hacks** — no runtime patching of Node/Electron APIs, no behavior that
   depends on bundler internals, nothing that silently degrades.
4. **No visible console windows**, ever, from the daemon or its children.
5. **Updates never fail on locked files** held by the daemon.
6. **Proof before release** — a scripted packaged-artifact update test must
   pass before any of this ships. Not optional, not ad-hoc.

## What the research established

A survey of the major open-source Electron terminal implementations, the
electron-builder NSIS internals, and Node/Electron upstream sources produced
these load-bearing facts:

1. **No mainstream Electron terminal app keeps live local sessions across a
   Windows auto-update.** The industry-standard behaviors are (a) a detached
   daemon that survives app *restarts* plus reconnect-by-id — which Orca
   already has — and (b) serialized-scrollback "revive": replay saved buffer
   text into a **fresh** shell after the update. One major agent-workspace app
   avoids the problem by disabling Windows auto-update entirely.
2. **The one architecture where live shells demonstrably survive a client
   update is the remote-server model**: the pty service runs in a process
   whose lifetime is independent of the app, and the restarted client
   reconnects to live sessions by persistent id within a grace window. Orca's
   daemon is already exactly this shape. The *only* structural difference from
   the surviving case is that our daemon's executable image lives in the
   install directory.
3. **The NSIS updater kills by image path.** electron-builder's
   `CHECK_APP_RUNNING` macro enumerates processes whose executable path starts
   with `$INSTDIR` and force-kills them (PowerShell CIM sweep; `taskkill /IM
   <AppExe>` name-based fallback). A process whose image lives under
   `%LOCALAPPDATA%` is untouched by both paths. There is a supported
   `customCheckAppRunning` override macro, but overriding it does not solve
   the locked-file problem (NSIS overwrites `$INSTDIR` in place), so
   relocation out of `$INSTDIR` is required regardless.
4. **Electron hides child consoles with a process-wide runtime flag, not a
   default-value patch.** Electron enables Node's `kHideConsoleWindows`
   environment flag (upstream: nodejs/node#39712), which passes
   `CREATE_NO_WINDOW` to *every* `CreateProcessW` from that Node instance —
   including spawns inside third-party code such as node-pty's internal
   console-list `fork()`. Stock `node.exe` cannot enable this flag, and its
   per-call `windowsHide` default is `false` (unchanged through Node 24; the
   attempt to flip it upstream was reverted). This is why the rc.5–rc.7
   standalone-node host flashed windows and why per-call-site fixes can never
   fully cover a stock-node host without also patching node-pty.
5. **Precedent for versioned relocated runtimes exists** at two levels we
   already rely on: the Squirrel-style installer layout runs entire apps from
   versioned `%LOCALAPPDATA%` directories (so signed executables running from
   user-writable app-data are normal on Windows), and the leading editor
   ships its own `conpty.dll` rather than depending on the OS copy.

## Design principle

**Change where the proven runtime lives, never what it is.** The daemon ran
for months, flash-free and interactive, as an `ELECTRON_RUN_AS_NODE` fork of
the app's own Electron binary. Every shipped failure in July came from
swapping that runtime for a different one (stock node) and then patching over
the differences. The plan keeps the exact runtime — `kHideConsoleWindows`,
asar semantics, identical Node version and N-API surface — and changes only
the path the image runs from, which is the single property the installer
cares about.

## Architecture

### Phase 0 — Proof harness + observability (ship first; gates everything)

Built **before** any survival change, because its absence is what let three
broken RCs ship.

- **Packaged-update E2E harness** (`tools/win-update-e2e/`): a script that
  takes two NSIS artifacts (version N = the last released build, version N+1 =
  the candidate), then on a real Windows machine or CI runner:
  1. Silently installs N; launches the app; creates terminal sessions; starts
     a long-running marker process in one (unique canary window title).
  2. Records the daemon PID and a baseline enumeration of visible top-level
     windows.
  3. Runs the N+1 installer in one-click silent mode; relaunches the app.
  4. Asserts: **daemon PID unchanged**; **marker process still running**;
     **input echoes** in the pre-update session (typed bytes observed in the
     output stream); **Ctrl+C interrupts**; **resize applies**; **zero new
     console/terminal windows** over a multi-minute watch (window enumeration
     with canary-title attribution and owner-process checks — never conhost
     command-line heuristics, which the post-mortem showed are invalid);
     **daemon log clean**.
  5. Runs a second update to exercise the stale-daemon replacement path and
     asserts cold-restore correctness when replacement is expected.
- **Daemon file logging**: the daemon writes a rotated log under the existing
  logs directory so it lands in diagnostic bundles. Field failures must be
  diagnosable without a live repro session. (In July we had literally zero
  daemon-side logs from affected machines.)
- **Cold-restore fidelity check**: verify the existing kill-and-restore path
  (scrollback + cwd) is solid, because it remains the fallback for protocol
  bumps, daemon crashes, and the one-time transition (below). This is the
  tried-and-tested baseline every surveyed app ships; it must stay good even
  when survival works.

Phase 0 is independently valuable and carries near-zero risk. **No later
phase merges until the harness exists and passes against current main**
(asserting today's behavior: daemon dies, cold-restore works, no flashing).

### Phase 1 — Relocate the daemon's entire file closure out of the install dir

- At app startup (background, once per app version), materialize
  `userData/daemon-host/<app-version>/` containing:
  - the app's Electron binary and the minimal file set required for
    `ELECTRON_RUN_AS_NODE` execution (determined empirically in a spike and
    then pinned by an explicit manifest — not guessed);
  - the daemon JS bundle and its chunk (copied as plain files — the daemon
    then never reads from asar at all, removing that entire failure class);
  - the node-pty native runtime (`.node` binaries, `conpty.dll` and agents) —
    this is the part #7421 got right.
- Fork the daemon from the relocated binary with `ELECTRON_RUN_AS_NODE=1`,
  detached, exactly as the daemon has always been forked — same flags, same
  env contract, same pipe naming. The only changed input is `execPath` and
  the script path.
- Result, by construction: the installer's path sweep cannot match the daemon
  (image outside `$INSTDIR`); the installer never encounters daemon-held
  locks (no daemon file handle points into `$INSTDIR`); console hiding and
  module semantics are byte-identical to the configuration that ran for
  months.
- **Copy integrity**: the manifest lists every file with its size/hash;
  materialization is atomic (temp dir + rename) and verified before first
  use; a failed or partial copy falls back to the current in-dir fork (status
  quo behavior, sessions die on update) rather than a broken daemon.
- **GC**: versioned directories, pinned by daemon pid-file liveness (the
  #7421 pinning design was sound); never delete a directory whose daemon is
  alive or hosts sessions.
- **Disk budget**: measured in the spike. Steady state is one version (plus a
  transient second during update overlap). If the measured minimal
  run-as-node set is unacceptably large, the documented fallback is the
  stock-node host **with** a build-time node-pty patch and a lint-enforced
  spawn wrapper — but that path re-inherits the entire rc.5–rc.7 hazard list
  and is taken only as a deliberate, separately-reviewed decision.

### Phase 2 — Adoption interactivity (the frozen-input class)

Survival is worthless if adopted sessions aren't interactive. Before Phase 1
ships to users:

- **Confirm the root cause.** The unconfirmed hypothesis from the field
  report: after adoption, the renderer write path (`writePtyInput`, strict
  `ptyOwnership.has()` gate in `src/main/ipc/pty.ts`) disagrees with the
  resize path (lenient provider fallback), so output flows and resize works
  while writes are silently dropped. Run the defined DevTools experiment
  (probe write acceptance → `listSessions()`, which rebuilds ownership as a
  side effect → re-probe) on an affected machine, or reproduce under the
  harness by updating across a daemon-adoption boundary and asserting the
  write path.
- **Fix at the source**: the write path and resize path must share one
  ownership-resolution mechanism; adoption must leave every session in a
  state where write/resize/ack behave identically to a freshly created
  session. No silent drops — a write that cannot be routed is a logged error.
- **Version-skew contract**, made explicit and tested: a new app adopting a
  protocol-v(N−1) daemon must provide *full* interactivity through the legacy
  adapters, or must visibly migrate via cold-restore. "Output works but input
  doesn't" must be structurally impossible, and the harness gains a
  cross-protocol-version update case whenever the protocol version bumps.

### Phase 3 — Rollout

- Each phase is its own PR with full CI (no skip-CI in this subsystem — now a
  hard rule) and harness evidence attached.
- **Transition population**: the first update *onto* the Phase 1 build still
  kills the old in-dir daemon (it was forked from the in-dir exe by the old
  app). That update loses sessions one last time — expected, and worth a
  release note. Survival applies from the following update onward. Machines
  that ran rc.5/rc.6 also clear their lingering flashy daemons at this
  boundary.
- **RC soak**: the RC runs on a real daily-driver machine through at least
  one genuine RC→RC update cycle (not just the harness) before promotion.

## Explicitly rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| Global `child_process` monkey-patch / `--require` preload shims | Defeated silently by bundler chunk hoisting and `util.promisify.custom` (shipped twice, broken twice — see post-mortem) |
| Stock `node.exe` host + per-call-site `windowsHide` | Cannot reach node-pty's internal fork without patching the dependency; loses `kHideConsoleWindows`, asar semantics, and environment parity; kept only as a documented fallback if the relocated-runtime size is unacceptable |
| `customCheckAppRunning` NSIS override to exempt the daemon | Supported hook, but the in-place `$INSTDIR` overwrite still hits daemon-held file locks; solves the kill, not the update |
| Squirrel-style versioned-directory installer | Would inherently allow old processes to keep running, but replacing the installer is a product-wide migration far outside this problem's scope |
| Windows service for the daemon | Requires elevation and changes the security/lifecycle model for a per-user dev tool |
| Accept session death + richer buffer-replay restore only | The industry default, and it remains our fallback tier — but it does not meet goal 1 (live processes) |

## Risks and unknowns (tracked, not hand-waved)

- **Minimal run-as-node file set** for the Electron binary is unknown until
  the spike measures it (import-table DLLs, `icudtl.dat`, v8 snapshots).
  Spike output = pinned manifest + measured size. This is the plan's main
  go/no-go gate, and it is deliberately first.
- **AV/SmartScreen** reaction to a signed exe copied into `%LOCALAPPDATA%`:
  precedent says this is normal on Windows (entire apps run from there), but
  the harness soak on a Defender-enabled machine is the proof.
- **Frozen-input hypothesis** may be wrong; Phase 2 starts with confirmation,
  not the fix.
- **Long paths / multi-user machines / roaming profiles**: userData is
  per-user and local; the manifest copy is per-user too. Covered by harness
  runs under a non-admin account.

## Verification is the feature

The July failure was not a bad idea — relocation out of the install dir is
the correct and, per the installer source, the *only* mechanism. The failure
was shipping four times without once installing the artifact. Accordingly,
this plan's first deliverable is the proof harness, every subsequent PR must
attach a passing harness run against real packaged artifacts, and the
definition of done for the project is a recorded harness pass across a real
released-RC → candidate update on a real machine.
