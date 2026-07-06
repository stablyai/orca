# Windows Terminal Update-Survival: Post-Mortem (July 2026)

## TL;DR

Over July 4–5, 2026, five PRs (#7421, #7463, #7473, #7486, #7499) tried to make
terminal sessions survive Windows auto-updates. They shipped four broken RCs in
two days — console-window flashing in rc.5 and rc.6, and a completely broken
daemon ("Daemon exited during startup with code 1") in rc.7 — and were fully
reverted in #7505. Windows behavior is back to the pre-July-4 status quo:
**updates kill terminal sessions and the app does a cold restore.**

Every one of the shipped failures was observable *only* in the packaged,
installed artifact. None of them were observable in unit tests, repo-tree
harnesses, or dev builds. That is the central lesson of this document.

## Background: why sessions die on update at all

- Terminal PTYs live in a **daemon process** so they survive app restarts. The
  daemon was historically forked from `Orca.exe` with `ELECTRON_RUN_AS_NODE=1`,
  meaning its executable image lives in the **install directory**.
- The NSIS one-click updater **kills every process whose executable image is
  inside the install directory** before copying files (its running-app check
  sweeps the install dir to avoid locked files). The daemon is therefore killed
  on every update, taking all shells with it.
- Independently, node-pty's native runtime (`conpty.node`, `conpty.dll`, worker
  binaries) was loaded from the install dir, so a surviving daemon would hold
  locks on files the installer wants to replace.

Solving this genuinely requires the daemon's executable image and its native
dependencies to live **outside** the install directory. That diagnosis was
correct. The execution failed.

## Timeline

| Change | Shipped in | Intent | Outcome |
| --- | --- | --- | --- |
| #7421 | rc.1–rc.3 | Relocate node-pty native runtime to a versioned `userData` copy (marker file, PID-pinned GC) so the daemon stops holding install-dir file locks | Worked as far as we know, but part of the trust collapse; reverted |
| #7463 | rc.3+ | Follow-up fixes to #7421's relocation machinery | Reverted with it |
| — | rc.2 (perf) | — | Field report: **frozen input** — pre-update tabs show live output but ignore keystrokes. Root cause never confirmed (see "Unresolved") |
| #7473 | rc.5 | Relocate the daemon *host*: stage a standalone `node.exe` (Node 24, N-API-compatible with Electron's Node) into `resources/daemon-host` at build, copy to `userData/daemon-host/<version>` at runtime, fork the daemon from it (no `ELECTRON_RUN_AS_NODE`), PID-file-pinned GC | **Console windows flashing every ~2–3 s** |
| #7486 | rc.6 | Global `child_process` shim in the daemon bundle forcing `windowsHide: true` | **Still flashing** — shim silently defeated twice over |
| #7499 | rc.7 | Move the shim to a `node --require` preload (runs before the module graph) and wrap the `util.promisify.custom` symbol; merged with skip-CI | **Daemon exited during startup with code 1** — terminals entirely broken |
| #7505 | rc.8 | Revert all five | Back to status quo |

## What actually went wrong, per failure

### rc.5 flashing: environment parity

Electron's bundled Node **patches `child_process` so `windowsHide` defaults to
`true`**. Stock `node.exe` defaults it to `false`. The moment the daemon host
switched from `Orca.exe` to standalone `node.exe`, every child process the
daemon spawns without an explicit `windowsHide` — the PowerShell CIM probes
behind foreground-process rows (every ~2–3 s per session) and node-pty's
console-list agent fork — allocated a visible console. With Windows Terminal as
the default console host, each one flashed a WT window.

This is a general class, not a one-off: swapping the host runtime silently
changes *every* implicit behavior the code depended on. The second instance of
the same class (asar support, below) killed rc.7.

### rc.6 still flashing: the shim was defeated twice, invisibly

1. **Bundler reordering.** The rollup CJS output hoists chunk `require()`s
   above the inlined entry-module code. "Import the shim first" in source
   order compiled to "load every chunk, *then* run the shim." Probe modules
   capture `promisify(execFile)` at module scope, so they froze references to
   the unpatched function before the shim installed. Verified after the fact
   by byte offsets in the shipped bundle: the chunk `require()` sat at byte
   ~375, the shim's installation at byte ~1063.
2. **`util.promisify.custom`.** Node's `exec`/`execFile` carry a
   `promisify.custom` symbol whose implementation calls the **original**
   function internally. The shim copied the symbol onto the wrapper verbatim,
   so every *promisified* call site — exactly the shape of the flashing
   probe — bypassed the injection entirely.

Both defeats are properties of monkey-patching global APIs: the patch has
invisible adversaries (bundler chunk ordering, hidden symbols, module-scope
captures) and fails **silently** — everything works, the windows just keep
flashing.

### rc.7 daemon dead on arrival: unverified packaging assumption

The `--require` preload approach was architecturally sound (a preload really
does run before the module graph), but the release shipped without ever
installing the packaged artifact. The most likely cause of "exited with code
1" — never confirmed, because we reverted instead — is that the preload file
was **not asar-unpacked**: Electron patches `fs` so code inside Electron can
read `app.asar`, but a standalone `node.exe` cannot, so `--require
<path-inside-asar>` dies instantly. The daemon bundle itself was verified
asar-unpacked in rc.5/rc.6; the *new file* added in rc.7 was not re-verified.
It was also merged with skip-CI under time pressure.

## Why verification missed every one of these

This is the part worth internalizing. Each failure had a verification step
that *passed* — against the wrong thing:

- **Harnesses ran source, not the shipped bundle.** The shim was validated
  with a tsx-driven harness that loads TypeScript modules individually — no
  rollup chunking, so defeat #1 could not occur there by construction.
- **The promisify check validated the wrong property.** It asserted the
  promisified call *returned correct results* — it did; it also flashed a
  window. Result-shape testing cannot catch a visibility bug.
- **Console-visibility heuristics were wrong.** conhost command-line flags
  were used as a visible/hidden discriminator; the interpretation inverts
  depending on the parent's console state. `MainWindowHandle` is `0` for
  WT-hosted consoles (the window belongs to `WindowsTerminal.exe`), so
  handle-based checks read "hidden" for visibly flashing windows.
- **Smoke tests ran under the wrong runtime.** Some smokes executed under the
  system Node 25 instead of the staged Node 24 host binary being shipped.
- **Ambient contamination.** The machine running the trials had a live broken
  daemon flashing on its own ~2–3 s cadence, contaminating window-count
  measurements until canary window titles isolated attribution.
- **The packaged NSIS artifact was never installed, not once,** before any of
  rc.5/rc.6/rc.7 went out. Every shipped failure required exactly that to be
  seen.

## Constraints validated by the saga (keep these; they were hard-won)

- The daemon **must** be spawned detached: libuv assigns non-detached children
  to a job object that kills them when the parent exits. Detached on Windows
  means `DETACHED_PROCESS` — *no console at all* — so the daemon cannot rely
  on "inheriting" a hidden console; children that allocate a console get a
  fresh, visible one unless explicitly suppressed.
- Old daemons keep running after an update until replaced. The staleness
  policy only replaces a stale-bundle daemon that has **no live sessions** — a
  misbehaving daemon that hosts sessions keeps its behavior until the user
  restarts the daemon. Any fix must plan for the transition population, not
  just fresh installs.
- Windows will happily rename a directory whose files are running images
  (rename-based "is it locked" probes are not valid).
- A standalone Node host cannot read inside `app.asar`. Everything in the
  daemon's require closure must be genuinely unpacked on disk, and this must
  be re-verified for every file the daemon loads, on every change.

## Unresolved issues carried forward

- **Frozen input (rc.2-era)**: pre-update tabs render live output but ignore
  keystrokes and Ctrl+C; new tabs are fine; app restart doesn't clear it.
  Leading hypothesis (unconfirmed): after daemon adoption, the renderer's
  write path (`writePtyInput`, strict `ptyOwnership.has()` gate) disagrees
  with the resize path (lenient provider fallback) about session ownership —
  output flows because the output fan-out is mapping-free, resize works via
  fallback, writes are dropped by the strict gate. A DevTools experiment to
  confirm (probe `writeAccepted`, then `listSessions()` — which rebuilds
  ownership as a side effect — then re-probe) was defined but never run on an
  affected machine.
- **rc.7 exit-code-1 root cause** is diagnosed-by-likelihood only (asar
  unpack), never confirmed.
- **Field machines that ran rc.5/rc.6** keep a flashing daemon until the user
  runs Manage Sessions → Restart Daemon (or reboots) after installing a fixed
  build.

## Non-negotiables for any future attempt

1. **No monkey-patching of global Node APIs.** Behavior differences between
   host runtimes are fixed at the call site (explicit options) or by choosing
   a host that doesn't have the difference — never by runtime patching.
2. **Packaged-artifact E2E is mandatory before release.** Install the real
   NSIS build, run a real update from the previous released version, and
   verify: daemon survives (same PID), terminals stay interactive (typed
   input echoes; Ctrl+C works), no console window appears over a multi-minute
   watch, daemon log is clean. Scripted and repeatable, not ad-hoc.
3. **No skip-CI merges in this subsystem.** rc.7 shipped a total failure that
   full CI plus rule 2 would have caught.
4. **Observability before features.** The daemon must write a log file that
   lands in diagnostic bundles *before* we ship another survival change, so a
   field failure is diagnosable without a live repro session.
