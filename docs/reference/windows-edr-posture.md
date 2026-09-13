# Windows EDR signal surface

Orca's Windows process tree is shaped like the thing behavioural EDR is built to
find. An enterprise Windows 11 / Intune tenant opened **six Microsoft Defender
for Endpoint incidents against Orca 1.4.192 in eight days**. All six fired as
active incidents and stayed open; three closed only because a human classified
them by hand in the portal. Defender never downgraded or closed one on its own.

None were signature hits. Every one was behavioural process-tree scoring, and
two escalated to multi-stage incidents carrying ATT&CK tactic mappings
(Execution, Collection).

The framing this document keeps throughout, because both halves matter:

> **Defender is not malfunctioning. It is describing the code accurately.** Orca
> really does copy its own signed image under a different name, really did read
> every process's memory on a timer, really does run base64-encoded PowerShell
> with the execution policy bypassed, and really does take screenshots and
> synthesise input from a runtime-compiled assembly. Each of those is a
> deliberate engineering choice with issue history behind it. The problem is not
> that the capabilities are illegitimate — it is that their **behavioural
> signature overlaps with attack techniques**, and an EDR scoring behaviour
> cannot see the difference.

Do not read this as a bug report against Defender, and do not read it as a claim
that Orca is malware. It is a map of which of our behaviours are legible to an
EDR as attack-technique-shaped, why each one exists, and what engineers and
administrators can do about it.

## What the tenant actually saw

Four independent evidence clusters, from six incidents:

| Cluster           | Incidents | Evidence                                                                                                                              |
| ----------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Update**        | A, B, C   | `orca-windows-setup.exe` → `old-uninstaller.exe`, `Uninstall Orca.exe` (electron-builder generates these; they are in no repo file)   |
| **Spawn**         | all six   | `Orca.exe` → `orca-terminal-daemon.exe` → `powershell.exe` / `pwsh.exe` / `cmd.exe` / `reg.exe` → `claude.exe`, `gh.exe`, `codex.cmd` |
| **Process table** | D         | "suspicious memory activity" — `OpenProcess` plus a PEB read against every process on a repeating cadence                             |
| **Computer use**  | E, F      | `runtime.ps1`, `computer-sidecar.js`, many `operation.json`, a burst of ~10 short-lived `powershell.exe`                              |

Incident E is the one to look at hardest: 5 alerts, 37 evidence items, ATT&CK
**Execution + Collection**, and a description reading _"Screenshots were taken
unexpectedly on this device… Screen capture code was found in a script launched
by powershell.exe."_ Incident F added _"suspicious MSIL code"_, from the
`Add-Type -TypeDefinition` that recompiles inline C# P/Invoke on every
operation.

In the update cluster the uninstaller is genuinely `NotSigned`, while `Orca.exe`
and `orca-terminal-daemon.exe` report `Valid CN=SignPath Foundation`.

## The behaviours, and why each one exists

### The daemon runs from a copy of our own image

`src/main/daemon/daemon-host-relocation.ts` copies the Electron runtime into
`%LOCALAPPDATA%\Orca\daemon-host\<version>\` and forks the terminal daemon from
there.

It exists because the NSIS installer deletes the old install directory and force-
kills every process imaged under it. Without relocation, an auto-update kills the
terminal daemon and every live terminal with it. The copy is a run-as-node
`Orca.exe` rather than `node.exe` so there is no console flash and asar still
resolves; `config/nsis/orca-installer-hooks.nsh` reaps it on a real uninstall
(guarded by `${isUpdated}` so an update's `uninstallOldVersion` never fires it).

**At the time of these incidents the copy was also renamed** to
`orca-terminal-daemon.exe`, the image name every incident here reports, and
`DAEMON_HOST_EXE_NAME`'s comment stated the reason without varnish: _"so the NSIS
updater's `taskkill /IM Orca.exe` can't match it."_ The rename has since been
removed; the copy now keeps the app exe's own file name, because the updater's
kill sweep is path-scoped on every host that has PowerShell and the rename only
ever bought the no-PowerShell fallback. See
[`windows-daemon-host-relocation.md`](./windows-daemon-host-relocation.md).

**How an EDR reads it: MITRE T1036, masquerading** — and, for what remains,
**T1036.005**. A signed executable copied out of the install directory into
`%LOCALAPPDATA%` under a different name, which then spawns shells, matches the
textbook description closely enough that no behavioural engine can be expected to
score it low. Dropping the rename removes that literal indicator but not the
underlying shape: execution from a non-standard user-writable location is scored
on its own. Note also that the strongest form of the T1036 signal was never
present here — the shipped binary's `OriginalFilename` is empty, so there was no
embedded name for the old disk name to contradict.

### Every process gets a handle, on a timer

`src/main/windows/windows-process-table.ts` takes a Toolhelp32 snapshot under one
of **two** flag sets: identity (`None | CreationTime`) for callers that read only
pid, ppid and name, and detailed (`+ CommandLine`) for callers that match on a
command line. pid, ppid and name come out of the snapshot itself and open
nothing, so an identity scan opens nothing at all. `CommandLine` is what opens a
handle: the addon calls `GetProcessCommandLine` per process, which opens
`PROCESS_QUERY_LIMITED_INFORMATION` — the same right Task Manager takes — and
asks the kernel for the string. Upstream it opened
`PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` and walked the PEB with three
`ReadProcessMemory` calls (`src/process_commandline.cc:32,41-47` in the vendored
`@vscode/windows-process-tree` 0.8.0 source that `config/patches/` patches).

`Memory` is retired as of this change, and that is a real reduction: it made
`GetProcessMemoryUsage` open a **second** `PROCESS_QUERY_INFORMATION |
PROCESS_VM_READ` handle per process for a `GetProcessMemoryInfo` call whose
result no caller read (`src/process.cc:47-63`). Dropping it halves the handles
opened per snapshot. On its own it removed no memory read — both handles carried
`PROCESS_VM_READ` at the time — so it composes with the patch below rather than
substituting for it.

It exists because seven independent readers used to fork `powershell.exe` for a
`Get-CimInstance Win32_Process` scan. That cost, measured: a PowerShell
Transcription policy recorded **~289 GB across 1.4 million files** because a scan
ran every ~2 seconds (#15209); a Group Policy or AV block turned a query into
"unavailable", which callers read as "no evidence", which is how a PTY tree
survived its own teardown (#9045, #10475); and the scan cost ~700 ms per pane, so
panes multiplied it (#15036). The native snapshot answers the same question in
15.9 ms against 706 ms for CIM — p50, measured on Windows 11 at 1050 processes.
See
[`windows-process-enumeration.md`](./windows-process-enumeration.md).

Asking for fewer fields is cheaper, and each caller now asks for the smallest set
that answers it. There are exactly **two** TTL-cached snapshots, one per flag
set, never one per caller: the fan-out the cache exists to remove is one scan per
_caller_, and each reader still serves every caller wanting its flag set, so a
32-wide teardown still collapses into one scan of each. Teardown identity and the
owner probe select the identity set and therefore open no handles; the per-pane
foreground tracker genuinely needs a command line and still pays for one. A third
cache would need a third flag set, not a third caller. Measured at 492 processes,
p50: identity 6.3 ms, detailed 12.3 ms — see
[`windows-process-enumeration.md`](./windows-process-enumeration.md).

**How an EDR read it:** a cross-process handle plus a remote memory read against
every process on the box, repeating on a cadence, is the read half of the
telemetry that credential dumping and process injection produce. MDE surfaced it
as "suspicious memory activity".

**The memory read is gone.** A fourth hunk in
`config/patches/@vscode__windows-process-tree@0.8.0.patch` has
`GetProcessCommandLine` call `NtQueryInformationProcess` with
`ProcessCommandLineInformation` (class 60, Windows 8.1+; Electron's floor is
Windows 10), which returns a `UNICODE_STRING` the kernel builds and needs only
`PROCESS_QUERY_LIMITED_INFORMATION`. Measured on ~540 processes, per detailed
scan: `ReadProcessMemory` 1128 → **0**, desired access `0x0410` → `0x1000`, with
byte-identical command lines on every process both readers recovered. There is no
PEB fallback to reinstate it — a hooked `ntdll` answering
`STATUS_INVALID_INFO_CLASS` for one target would have flipped a process-wide,
one-way switch back to `PROCESS_VM_READ` on exactly the machines this exists for.

Because the property is the _absence_ of an import, it is checkable on the
artifact rather than the source: `inspectWindowsProcessTreeAddon()` answers
`clean` / `unpatched` / `missing`, and the rebuild, `ensure-native-runtime.mjs`,
the relay build and `loadWindowsProcessTree()` all key on it. That check is load-
bearing because the published tarball ships a _loadable_ prebuilt built from
unpatched source, so "it required cleanly" is not evidence.

What to declare to administrators is now one
`PROCESS_QUERY_LIMITED_INFORMATION` handle per process on a detailed snapshot and
no remote memory access at all; an identity snapshot opens nothing. What this
does not narrow is _which_ processes are asked — a detailed scan still queries
every pid, including `lsass.exe`. Restricting the command-line pass to Orca's own
subtree needs job-object membership as its source of truth (a ppid-derived
allowlist would miss the detached, reparented descendants of #9045 and #10475),
and remains unclaimed work.

### Encoded, policy-bypassing PowerShell

Three sites are named in the incident analysis:

- `src/relay/windows-port-scan.ts` ran
  `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand` over a
  `Get-NetTCPConnection -State Listen` script to find dev-server ports.
  Enumerating listening ports is **MITRE T1049**, network service discovery, and
  doing it through an encoded policy-bypassed shell is the aggravating factor
  rather than the finding itself. The ordinary scan now starts no PowerShell at
  all — `netstat.exe -ano`, with the owning process name projected off the shared
  native table — and that payload survives only as the last-resort fallback, as
  `-Command` with no policy override.
- `src/main/daemon/shell-ready.ts` uses `-EncodedCommand` for the OSC 133
  bootstrap.
- `src/main/agent-hooks/windows-powershell-hook-launcher.ts` wraps managed hooks.

**No site spells the pair any more.** `src/main/ssh/ssh-remote-powershell.ts`,
`src/shared/setup-agent-sequencing.ts`,
`src/shared/windows-cmd-runner-delayed-launch.ts` and
`src/shared/windows-interactive-login-spawn.ts` each dropped
`-ExecutionPolicy Bypass` as a measured no-op: the policy gates script _files_,
never `-EncodedCommand`. Where the bypass was load-bearing it moved in-payload as
a process-scope `Set-ExecutionPolicy` (`setup-agent-sequencing.ts`), which is the
pattern to copy rather than restoring the switch — the switch loses to a GPO
scope anyway, so it never covered the locked-down case.

What remains is `-EncodedCommand` without the bypass: the PTY bootstraps
(`src/main/daemon/shell-ready.ts`, `src/main/providers/local-pty-shell-ready.ts`,
`src/main/providers/windows-shell-args.ts`), the hook wrappers
(`src/main/agent-hooks/windows-powershell-hook-launcher.ts` and its callers
`src/main/agent-hooks/runtime-home-hook-command.ts`,
`src/main/agent-hooks/installer-utils.ts`, and `src/main/claude/hook-settings.ts`
— that last one only as a _fallback_ since #18875, see below),
`src/main/runtime/windows-default-route-interfaces.ts`,
`src/main/runtime/orchestration/setup-completion-signal.ts`,
`src/shared/hermes-startup-query.ts`, and the four ex-bypass sites above.
`src/main/runtime/windows-mobile-firewall.ts` encodes a script and launches it
_elevated_ through `Start-Process -Verb RunAs`, which is a stronger shape than
any of those; only that hop is encoded, because `-ArgumentList` re-splits an
unquoted parameter string on whitespace.

One site still spells `-ExecutionPolicy Bypass` with **no** encoding, the weaker
signal: `src/main/cli/wsl-cli-scripts.ts` (`-File`, and it is a real script
file, so the switch is not a no-op there). `src/main/system-fonts.ts` dropped it
for plain `-Command`; `src/shared/secure-path-windows-acl.ts` no longer runs
PowerShell at all, having moved to `icacls.exe`; and computer use now asks for
`-ExecutionPolicy RemoteSigned` in
`src/main/computer/windows-powershell-execution-policy.ts`, falling back to
`Bypass` only after a policy-blocked start.

Regenerate with `rg -- '-EncodedCommand|-ExecutionPolicy' src/` rather than
trusting the lists above, and note that a raw grep under-reports: the hook sites
reach `-EncodedCommand` through `wrapWindowsPowerShellEncodedCommand` and never
spell the flag themselves.

Encoding is not gratuitous: it shields paths and switches from `cmd.exe` and MSYS
rewriting (#6078, #14815), which is a real class of corruption. But
`-EncodedCommand` is a first-class Defender alert title ("Suspicious PowerShell
command line"), and base64 raises the score rather than lowering it, because it
denies the analyser the payload it would otherwise clear.

The hook launcher is prior art worth knowing about. #16003 measured, on a
reporting Kaspersky host, that `-WindowStyle Hidden` paired with
`-EncodedCommand` was denied at `CreateProcess` with exit 126 regardless of
payload — `exit 0` was denied too. The fix was to stop _spelling_ the flags:
`WINDOWS_POWERSHELL_HOOK_SWITCHES` is now just `-NoProfile`, and separately, in
#16576, the execution policy bypass moved in-payload as a process-scope
`Set-ExecutionPolicy` — a real command-line signal reduction, though #16003's
measured denial keyed on `-WindowStyle Hidden` + `-EncodedCommand`, not on the
bypass. It is also honest that the underlying behaviour did not change.

Copy the pattern, but copy its caveat too. `windows-powershell-hook-launcher.ts`
records that dropping `-WindowStyle Hidden` was a real tradeoff whose suppression
"was never measured" and "remains unverified on a real box". Reducing spelled
flags is the right instinct; treat any specific claim about what a removed flag
was doing as unproven until someone measures it.

### `cmd.exe /c` carrying caret-escaped free text

`buildWindowsCmdShimCommandLine` in
`src/shared/child-process/windows-command-line.ts` builds `/d /v:off /s /c "…"`
for the `.cmd` and `.bat` targets Windows can only start through `cmd.exe`
(`codex.cmd` being the one that matters). Because cmd expands `%VAR%` even inside
a quoted token, each `%` is broken with `"^%"`.

The escaping is not decorative. Measured on Windows 11 against a real `.cmd`
shim, `["a b", 'c"d', "e%F%g", "h&i", "j^k"]` came back as `["a b", 'c"d',
"e^%F^%g", "h"]` — the `&` truncated the argument _and_ ran the remainder as a
command.

**How an EDR reads it:** caret escaping is the canonical obfuscation marker in
`cmd.exe` command lines, and the free text being escaped here is an agent prompt,
so the line is long, high-entropy, and attacker-shaped. It is the exact input an
obfuscated-command-line detector is tuned on.

### The spawn tree itself

`Orca.exe` → the relocated daemon host (`orca-terminal-daemon.exe` in the builds
these incidents cover, `Orca.exe` since) → a shell → an agent CLI is what a
terminal multiplexer for coding agents _is_. `reg.exe` appears from
`src/main/win32-utils.ts`,
`src/main/agent-hooks/managed-hook-owner-identity.ts` and
`src/relay/pty-shell-utils.ts` (reading the OpenSSH `DefaultShell`).

Nothing here is avoidable in principle. What is controllable is depth and
breadth: every interpreter hop between Orca and the thing the user asked for adds
a scored edge, which is why the shipped doctrine of #15520 and #15595 is to
_shorten the interpreter chain_ rather than to hide a window.

#18875 is a worked example of that doctrine. The Claude Code lifecycle hook was
registered as `powershell.exe -NoProfile -EncodedCommand <...>` whose entire
decoded payload was a `Test-Path` and a call to `~/.orca/agent-hooks/claude-hook.cmd`.
It now registers the script path itself (`<path> || echo {}`), so `bash ->
powershell -> cmd -> curl` became `bash -> cmd -> curl` and one
`powershell.exe -EncodedCommand` per hook event — a first-class Defender alert
title — leaves the tree. The reporting box fired ~6 900 of them in five days,
70% from Claude sessions that were not running under Orca at all and whose hook
exits at its first `ORCA_PANE_KEY` guard.

What is measured is latency and the hop count, nothing else: median 471 ms ->
213 ms per event idle, and 656 ms -> 296 ms (p95 696 ms -> 337 ms) under 10-way
concurrency, invoked as Claude Code invokes it. **No EDR verdict on either tree
was measured**, so claim the removed `-EncodedCommand` spelling and the shorter
chain, not a score. `cmd.exe` remains in the tree, spelled by MSYS's own `.cmd`
spawn rather than by us — the doc's one "unavoidable for `.cmd`/`.bat`" case,
carrying an absolute path and two literal tokens, with no caret escaping, no
encoding and no free text. The encoded launcher is still the shape for profile
paths the shells cannot carry bare (a space, `%`, `^`, `&`, non-ASCII, a UNC
profile) and for hosts where Git Bash is not resolvable, because PowerShell 5.1
rejects `||` (measured: parse error, exit 1).

That last clause is the standing assumption of this change, and it is worth
stating plainly because it is **not** measured. `||` parses in Git Bash, cmd.exe
and pwsh, but not in Windows PowerShell 5.1, so the direct shape is correct for
any host that is one of the first three. Claude Code itself is a Git Bash host on
native Windows. What no one here has verified is which host a _compat consumer_
uses: cursor-agent and Devin import `~/.claude/settings.json` and run `command`
through their own launcher (the managed `.cmd` carries a `DEVIN_PROJECT_DIR` skip
for exactly that). If one of them spawns hook strings through Windows PowerShell
5.1, its imported Claude events become a parse error with empty stdout, which is
the fail-closed case #14818 exists to prevent. The encoded launcher had no such
assumption — it was a `powershell.exe` invocation and therefore parsed anywhere.
Before widening the direct shape to another agent, measure that consumer's host.

### Computer use: screen capture, synthetic input, runtime-compiled MSIL

`native/computer-use-windows/runtime.ps1` is a large PowerShell script.
`src/main/computer/desktop-script-provider-bridge.ts` launches it as
`powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned
-File runtime.ps1 <operation.json>`, retrying once at `Bypass` only if the start
comes back policy-blocked — **once per operation**, with
`desktop-script-provider-client.ts` writing a fresh `operation.json` into a new
temp directory each time. On every launch the script runs `Add-Type
-TypeDefinition` over inline C# that P/Invokes `SendInput` and the window APIs,
then captures the screen through `Graphics.CopyFromScreen`.

That is four separate high-signal behaviours stacked in one process:

| Behaviour                                     | How it is scored                                              |
| --------------------------------------------- | ------------------------------------------------------------- |
| `Graphics.CopyFromScreen`                     | **MITRE T1113**, screen capture — Collection tactic           |
| `SendInput` synthetic keyboard/mouse          | input synthesis against other applications                    |
| `Add-Type -TypeDefinition` on every operation | MSIL compiled at runtime; incident F's "suspicious MSIL code" |
| One `powershell.exe` per operation            | a burst of short-lived interpreters under one parent          |

The bottom two rows are the two the incident text named directly, and they are
also the two a persistent runtime host would remove: a long-lived helper compiles
its P/Invoke stubs once and answers operations over a channel, so neither the
MSIL recompilation nor the interpreter burst repeats. A change doing that is in
flight and unmerged at the time of writing; check the code rather than this
paragraph for what the shipped build does. Screen capture and `SendInput` are
inherent to the feature and no refactor removes them.

## Signing is not the gate

The most useful calibration in the whole incident set came from the reporter's
own machine: **Antigravity IDE's main executable is `NotSigned` and was not
flagged, while Orca's is signed and was flagged six times.** Their conclusion:
_"signing is not the gate here — behaviour is."_

The mechanism is that Defender reputation is signer **plus prevalence**, and
prevalence is keyed on **file hash**. A widely installed unsigned binary clears
on install count alone. Orca's signature is a free OV certificate from SignPath
Foundation (`config/electron-builder.config.cjs` sets
`win.signtoolOptions.publisherName`; `config/scripts/verify-windows-inner-signature.mjs`
pins `CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US`),
shared across many OSS projects, with no independent SmartScreen or MAPS
reputation of its own. Every release ships new hashes, so whatever prevalence a
build accumulates resets on the next update. Dev channels ship unsigned by
design, because SignPath's approval waits cannot fit a dev cadence
(`config/scripts/verify-dev-channel-packaging.mjs`).

Signing the uninstaller is worth doing — an unsigned `old-uninstaller.exe`
running under a signed installer is a gratuitous contribution to the update
cluster — but do not expect it to change the behavioural verdict. The three
non-update clusters contain no unsigned binary at all.

## What we do not know

Two limits the incident analysis recorded, kept here rather than smoothed over:

- **No data on Hermes.** Nothing in this document describes how Hermes behaves
  under the same tenant policy — though `src/shared/hermes-startup-query.ts` does
  spell `-EncodedCommand`, so the gap is telemetry, not surface.
- **Antigravity not being flagged is absence of evidence, not proof.** It is one
  reporter's recollection from one machine, not a measurement. It is strong
  enough to falsify "the problem is that we are not signed well enough"; it is
  not strong enough to support a positive claim about how Defender scores that
  product.

Add to those: this is one tenant with one policy configuration. Whether the same
build scores the same way elsewhere is unmeasured.

## Guidance for engineers

Fixes for several of the shapes above are in flight in separate changes; nothing
in this section should be read as a statement that a given site has already
changed. Check the code before relying on it.

The checklist. On Windows, do not reach for:

| Don't                                         | Instead                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `-ExecutionPolicy Bypass` on the command line | Set the policy in-payload at process scope, as `windows-powershell-hook-launcher.ts` does, or do not run a `.ps1` at all            |
| `-EncodedCommand`                             | A temp `.ps1` with an argument, or no PowerShell hop: prefer a native API or an existing Node path                                  |
| `cmd.exe /c` carrying escaped free text       | Spawn the real target directly. `cmd.exe` is only unavoidable for `.cmd`/`.bat`; keep free text out of the line where you can       |
| Forking `powershell.exe` to read system state | The native reader — [`windows-process-enumeration.md`](./windows-process-enumeration.md) is the standing rule for the process table |
| A process per operation in a loop             | One long-lived helper with a request channel. A burst of short-lived interpreters under one parent is itself the signal             |
| `Add-Type -TypeDefinition` at runtime         | A precompiled, signed assembly, or a native helper                                                                                  |
| Copying our own image under a different name  | Copy it verbatim — [`windows-daemon-host-relocation.md`](./windows-daemon-host-relocation.md) (done for the daemon host)            |
| Deriving a script runner from a UI preference | [`windows-setup-shell.md`](./windows-setup-shell.md) — the script declares its own interpreter                                      |

Two framing rules that outlast the table:

- **Shorten the interpreter chain.** Each hop between Orca and the user's actual
  target is a scored edge and a place for AV to deny a `CreateProcess`. This is
  the shipped doctrine of #15520 and #15595.
- **Do not spell a flag you can avoid spelling.** #16003 measured a denial that
  was independent of the payload and keyed purely on the switch combination on
  the command line. What is on the line is itself the detection surface.

## Guidance for administrators deploying Orca

### Path exclusions alone will not silence these

This is the single most important operational point, and it is the one most
commonly got wrong. The six incidents are **MDE EDR behavioural alerts**.
Defender Antivirus path exclusions suppress _scan_ detections; they do not
suppress EDR behavioural alerts the same way. Adding
`%LOCALAPPDATA%\Programs\orca\` to the AV exclusion list and expecting the
incidents to stop will not work.

### What actually stops incidents being created

An **MDE alert suppression rule** scoped to the process tree. Build it in
Microsoft 365 Defender (Settings → Endpoints → Alert suppression), conditioned
on:

- **Alert titles** — `A suspicious file was observed` and
  `Suspicious PowerShell command line`, plus any further titles your tenant
  actually produced. Take the titles from your own incidents rather than from
  this list.
- **File paths** — `Orca.exe` and `orca-terminal-daemon.exe` under
  `%LOCALAPPDATA%\Programs\orca\` and `%LOCALAPPDATA%\Orca\daemon-host\`.

Scope it as narrowly as your tenant will tolerate, and review it when Orca
updates: the `daemon-host` path carries a `<version>` segment, so a rule pinned
to one version will silently stop matching. Two traps in that path in particular.
Materialization stages into a `<version>.staging-<hex>` sibling before renaming
it into place, so an exact-version rule misses the tree **mid-update** — which is
precisely when the update-cluster incidents fire. And the root falls back to the
Electron `userData` path when `LOCALAPPDATA` is unset, so
`%LOCALAPPDATA%\Orca\daemon-host\` is the normal location rather than a
guaranteed one. Prefer a prefix match on `…\Orca\daemon-host\` over a rule
pinned to one full path.

Add AV path exclusions for those two directories as well — they cut scan cost on
a tree that is rewritten on every update — but understand the division of
labour. The exclusions reduce scanning; **the suppression rule is what stops
incidents being created.**

### Check your ASR rules

Check whether the tenant has the Attack Surface Reduction rule **"Block
executable files from running unless they meet a prevalence, age, or trusted list
criterion"** enabled. If it is, that alone explains a freshly signed Orca build
being hit immediately after every update: each release ships new hashes, so every
build starts at zero prevalence and zero age no matter how it is signed. Either
allowlist the Orca install paths for that rule or expect a hit on each update.

### Expect the alerts to recur after each update

Prevalence is keyed on file hash. An update replaces the hashes, the reputation
starts over, and a suppression rule is the only thing carrying across.

## Computer use: decide before you deploy

Read this section before enabling computer use on a monitored endpoint, not
after.

> **On a monitored endpoint, an alert reading "Screenshots were taken
> unexpectedly on this device" is not the kind of finding a SOC dismisses on
> sight.**

Incident E is the shape to expect: 5 alerts, 37 evidence items, a multi-stage
incident mapped to ATT&CK **Execution + Collection**, and a description naming
screen capture found in a script launched by `powershell.exe`. Incident F adds
runtime-compiled MSIL to the same tree.

Every part of that is an accurate description of what the feature does. Orca's
computer use takes screenshots, synthesises keyboard and mouse input into other
applications, and compiles the P/Invoke stubs it needs at runtime. An
organisation that monitors for Collection-tactic activity — and any organisation
running MDE with default incident creation does — will see it, and will see it
as Collection.

So decide deliberately, in advance:

- **Allowlist it**, with a suppression rule covering the computer-use tree
  (`powershell.exe` with `-File …\runtime.ps1`) as well as the base Orca paths,
  and tell your SOC what it is before the first incident rather than during it.
- **Or leave it disabled** on monitored endpoints.

What does not work is deploying it un-triaged and handling the incidents
reactively. By the time a Collection-tactic incident is open, an analyst is
already reading a description of screenshots being taken without the user's
knowledge, and the burden of proof has moved to you.
