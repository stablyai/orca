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
> really does copy its own signed image under a different name, really does read
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

| Cluster           | Incidents | Evidence                                                                                                             |
| ----------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| **Update**        | A, B, C   | `orca-windows-setup.exe` → `old-uninstaller.exe`, `Uninstall Orca.exe` (electron-builder generates these; they are in no repo file) |
| **Spawn**         | all six   | `Orca.exe` → `orca-terminal-daemon.exe` → `powershell.exe` / `pwsh.exe` / `cmd.exe` / `reg.exe` → `claude.exe`, `gh.exe`, `codex.cmd` |
| **Process table** | D         | "suspicious memory activity" — `OpenProcess` plus a PEB read against every process on a repeating cadence            |
| **Computer use**  | E, F      | `runtime.ps1`, `computer-sidecar.js`, many `operation.json`, a burst of ~10 short-lived `powershell.exe`             |

Incident E is the one to look at hardest: 5 alerts, 37 evidence items, ATT&CK
**Execution + Collection**, and a description reading _"Screenshots were taken
unexpectedly on this device… Screen capture code was found in a script launched
by powershell.exe."_ Incident F added _"suspicious MSIL code"_, from the
`Add-Type -TypeDefinition` that recompiles inline C# P/Invoke on every
operation.

In the update cluster the uninstaller is genuinely `NotSigned`, while `Orca.exe`
and `orca-terminal-daemon.exe` report `Valid CN=SignPath Foundation`.

## The behaviours, and why each one exists

### The daemon runs from a renamed copy of our own image

`src/main/daemon/daemon-host-relocation.ts` copies the Electron runtime into
`%LOCALAPPDATA%\Orca\daemon-host\<version>\` and renames `Orca.exe` to
`orca-terminal-daemon.exe`. The comment on `DAEMON_HOST_EXE_NAME` states the
reason without varnish: _"so the NSIS updater's `taskkill /IM Orca.exe` can't
match it."_

It exists because the NSIS installer deletes the old install directory and force-
kills every process imaged under it. Without relocation, an auto-update kills the
terminal daemon and every live terminal with it. The copy is a run-as-node
`Orca.exe` rather than `node.exe` so there is no console flash and asar still
resolves; `config/nsis/daemon-host-uninstall.nsh` reaps it on a real uninstall
(guarded by `${isUpdated}` so an update's `uninstallOldVersion` never fires it).

**How an EDR reads it: MITRE T1036, masquerading.** A signed executable copied
out of the install directory into `%LOCALAPPDATA%` under a different name, which
then spawns shells, matches the textbook description closely enough that no
behavioural engine can be expected to score it low.

### Every process gets a handle, on a timer

`src/main/windows/windows-process-table.ts` takes a Toolhelp32 snapshot under
**one** flag set, `CommandLine | CreationTime`, shared by every caller. pid, ppid
and name come out of the snapshot itself and open nothing. `CommandLine` is what
opens a handle: the addon calls `GetProcessCommandLine` per process, which opens
`PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` and walks the PEB with three
`ReadProcessMemory` calls (`src/process_commandline.cc:32,41-47` in the vendored
`@vscode/windows-process-tree` 0.8.0 source that `config/patches/` patches).

`Memory` is retired as of this change, and that is a real reduction: it made
`GetProcessMemoryUsage` open a **second** `PROCESS_QUERY_INFORMATION |
PROCESS_VM_READ` handle per process for a `GetProcessMemoryInfo` call whose
result no caller read (`src/process.cc:47-63`). Dropping it halves the handles
opened per snapshot. It does not remove the remote memory read, because the
command line still performs one.

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

Asking for fewer fields is cheaper, and the module now asks for the smallest set
that still answers every caller. There is **no** per-flag-set cache split: one
TTL-cached snapshot serves everyone, deliberately, because a split would restore
the per-pane fan-out the cache exists to remove — a 32-wide teardown has to
collapse into one scan. So the cheap identity-only read is not something any
caller can select; every read pays for `CommandLine`. An earlier revision of this
file described a two-cache design with 6.3 ms / 12.3 ms p50 figures at 492
processes. That design is not in the tree and those numbers describe no code
path here; the figures that do apply are the module's own, in
[`windows-process-enumeration.md`](./windows-process-enumeration.md).

**How an EDR reads it:** a cross-process handle plus a remote memory read against
every process on the box, repeating on a cadence, is the read half of the
telemetry that credential dumping and process injection produce. MDE surfaced it
as "suspicious memory activity".

**That signal is still present.** An earlier revision of this file claimed the
command line "now comes from the kernel" through `NtQueryInformationProcess`'s
`ProcessCommandLineInformation` class, needing only
`PROCESS_QUERY_LIMITED_INFORMATION`, and that `ReadProcessMemory` was absent from
the compiled addon. None of that is true of the code we ship.
`process_commandline.cc` calls `NtQueryInformationProcess` with
`ProcessBasicInformation` only — to locate the PEB — and then issues three
`ReadProcessMemory` calls against a `PROCESS_VM_READ` handle to read the PEB, the
`RTL_USER_PROCESS_PARAMETERS`, and the command-line buffer. Nothing asserts an
import table, and no such assertion would pass.

What this change did remove is the `Memory` flag's second handle and its
`GetProcessMemoryInfo` call, so the per-process handle count per snapshot halves.
What remains to declare to administrators is unchanged in kind: one
`PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` handle and a PEB read against every
process on the box, at the shared snapshot's cadence. Moving to
`ProcessCommandLineInformation` (Windows 8.1+, `PROCESS_QUERY_LIMITED_INFORMATION`
only) would genuinely retire the remote read, but it is an addon patch nobody has
written; treat it as unclaimed work, not as shipped.

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
`-ExecutionPolicy Bypass` as a measured no-op: the policy gates script *files*,
never `-EncodedCommand`. Where the bypass was load-bearing it moved in-payload as
a process-scope `Set-ExecutionPolicy` (`setup-agent-sequencing.ts`), which is the
pattern to copy rather than restoring the switch — the switch loses to a GPO
scope anyway, so it never covered the locked-down case.

What remains is `-EncodedCommand` without the bypass: the PTY bootstraps
(`src/main/daemon/shell-ready.ts`, `src/main/providers/local-pty-shell-ready.ts`,
`src/main/providers/windows-shell-args.ts`), the hook wrappers
(`src/main/agent-hooks/windows-powershell-hook-launcher.ts` and its callers
`src/main/agent-hooks/runtime-home-hook-command.ts`,
`src/main/agent-hooks/installer-utils.ts`, `src/main/claude/hook-settings.ts`),
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
payload — `exit 0` was denied too. The fix was to stop *spelling* the flags:
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
"e^%F^%g", "h"]` — the `&` truncated the argument *and* ran the remainder as a
command.

**How an EDR reads it:** caret escaping is the canonical obfuscation marker in
`cmd.exe` command lines, and the free text being escaped here is an agent prompt,
so the line is long, high-entropy, and attacker-shaped. It is the exact input an
obfuscated-command-line detector is tuned on.

### The spawn tree itself

`Orca.exe` → `orca-terminal-daemon.exe` → a shell → an agent CLI is what a
terminal multiplexer for coding agents *is*. `reg.exe` appears from
`src/main/win32-utils.ts`,
`src/main/agent-hooks/managed-hook-owner-identity.ts` and
`src/relay/pty-shell-utils.ts` (reading the OpenSSH `DefaultShell`).

Nothing here is avoidable in principle. What is controllable is depth and
breadth: every interpreter hop between Orca and the thing the user asked for adds
a scored edge, which is why the shipped doctrine of #15520 and #15595 is to
*shorten the interpreter chain* rather than to hide a window.

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

| Behaviour                                       | How it is scored                                     |
| ----------------------------------------------- | ---------------------------------------------------- |
| `Graphics.CopyFromScreen`                       | **MITRE T1113**, screen capture — Collection tactic  |
| `SendInput` synthetic keyboard/mouse            | input synthesis against other applications           |
| `Add-Type -TypeDefinition` on every operation   | MSIL compiled at runtime; incident F's "suspicious MSIL code" |
| One `powershell.exe` per operation              | a burst of short-lived interpreters under one parent |

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

| Don't                                                       | Instead                                                                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `-ExecutionPolicy Bypass` on the command line               | Set the policy in-payload at process scope, as `windows-powershell-hook-launcher.ts` does, or do not run a `.ps1` at all    |
| `-EncodedCommand`                                           | A temp `.ps1` with an argument, or no PowerShell hop: prefer a native API or an existing Node path                          |
| `cmd.exe /c` carrying escaped free text                     | Spawn the real target directly. `cmd.exe` is only unavoidable for `.cmd`/`.bat`; keep free text out of the line where you can |
| Forking `powershell.exe` to read system state               | The native reader — [`windows-process-enumeration.md`](./windows-process-enumeration.md) is the standing rule for the process table |
| A process per operation in a loop                           | One long-lived helper with a request channel. A burst of short-lived interpreters under one parent is itself the signal     |
| `Add-Type -TypeDefinition` at runtime                       | A precompiled, signed assembly, or a native helper                                                                          |
| Copying our own image under a different name                | An installer or updater that does not need the rename. Where the rename is load-bearing, document it as such                |
| Deriving a script runner from a UI preference               | [`windows-setup-shell.md`](./windows-setup-shell.md) — the script declares its own interpreter                              |

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
Defender Antivirus path exclusions suppress *scan* detections; they do not
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
