# Agent Hook Stdin Lifecycle

## Problem

Orca installs agent hooks in global agent configuration, so a managed hook can
run in an Orca pane, an SSH/WSL runtime, a detached session, or an ordinary
terminal with no Orca environment. Hook runners write an event payload to the
child process's stdin after spawn.

The generated scripts currently inspect Orca environment variables before they
read stdin. When a guard exits first, the hook runner can still be writing to a
pipe whose reader has closed. POSIX reports `EPIPE`; Windows reports
`ERROR_BROKEN_PIPE`. The same failure exists when a managed launcher finds that
its script was removed or is no longer executable.

This is an ownership bug rather than an agent-specific parsing bug. Every
process that accepts a hook payload owns the read end until it reaches EOF,
including processes that decide the event is irrelevant.

## Goals

- Make successful hook no-ops consume stdin to EOF on macOS, Linux, Windows,
  WSL, and SSH hosts.
- Encode stdin ownership once per platform instead of copying ad hoc drains
  into every early-exit branch.
- Preserve payload bytes, hook output, transport timeouts, exit-code behavior,
  and provider-specific event metadata on the forwarding path.
- Cover every generated script and missing-script launcher with behavioral
  regression tests.

## Non-goals

- Do not redesign hook configuration schemas, endpoint discovery, relay HTTP
  payloads, or event selection.
- Do not make hook payloads unbounded; existing agent and config timeouts remain
  the outer lifecycle bound.
- Do not suppress failures from a script that exists and actually runs. Only a
  deliberate no-op path exits successfully after consuming stdin.
- Do not change plugin-based integrations that do not receive piped hook stdin.

## Contract

1. A generated hook script consumes its input exactly once.
2. No whole-script success exit may occur before that consumption completes.
3. A launcher that declines to start a missing, unreadable, or non-executable
   managed script becomes the stdin owner and drains to EOF before returning
   success.
4. A launcher propagates the exit code of a managed script that was started.
5. Output required by an agent protocol may be emitted before stdin is read,
   but the process must still retain the read end until EOF.
6. Drain commands are platform-qualified where the platform searches the
   working directory implicitly.

## Design

### POSIX generated scripts

Capture stdin near the start of the generated script, after any protocol output
that must be immediate and before endpoint refresh, environment guards, or
provider-specific skips:

```sh
payload=$(cat)
if [ -z "$payload" ]; then
  exit 0
fi
```

Antigravity is the one semantic exception: events without payload still post an
empty object, so its shared capture policy maps empty input to `{}` instead of
exiting. Claude's Devin-import skip happens after capture. Command Code captures
before ancestor/endpoint recovery so its comparatively expensive discovery
cannot leave the writer blocked.

The common payload-capture fragments live in
`src/main/agent-hooks/hook-stdin-contract.ts`. Templates choose the required or
empty-object policy instead of spelling the lifecycle independently.

### Windows batch generated scripts

Batch scripts stream stdin directly into system `curl.exe`; buffering arbitrary
JSON in an environment variable would corrupt metacharacters and hit size
limits. Their posting path therefore remains streaming.

All environment guard failures jump to one epilogue:

```bat
if "%ORCA_AGENT_HOOK_PORT%"=="" goto :orca_agent_hook_drain_stdin
...
exit /b 0
:orca_agent_hook_drain_stdin
"%SystemRoot%\System32\more.com" >nul 2>nul
exit /b 0
```

`more.com` is qualified because Windows searches the current working directory
for executables. Shared guard and epilogue builders keep labels and commands
identical across templates. Command Code's existing endpoint-discovery labels
remain subroutines and the drain epilogue is placed after them.

### PowerShell generated scripts

PowerShell captures with `[Console]::In.ReadToEnd()` before endpoint and
environment guards. Copilot then parses the captured value only on the posting
path. This mirrors POSIX ownership without starting an additional process.

### Managed launchers

- POSIX `/bin/sh` launchers require a regular, readable, executable file. The
  rejected path drains with `cat`; the started-script branch keeps propagating
  status.
- Encoded PowerShell launchers use `Test-Path -PathType Leaf`. A missing script
  calls `[Console]::In.ReadToEnd()` and exits zero; an existing script preserves
  `$LASTEXITCODE`.
- Codex's (and Antigravity's/Devin's) cmd fast path is the bare, directly
  spawnable `.cmd` path. These agents launch the hook command as a program
  (argv[0]), not through cmd.exe, so the launcher cannot lead with a cmd builtin
  such as `if` — that argv[0] is unspawnable and fails every hook. A missing
  script therefore surfaces a normal launch failure on this fast path; only
  launchers that already require a real interpreter (encoded PowerShell, Git
  Bash) drain a missing script. Paths cmd.exe cannot invoke verbatim fall back to
  the encoded PowerShell launcher, which owns stdin for the missing case.
- Claude's Git Bash fast path uses a POSIX file guard and drain while continuing
  to execute the `.cmd` directly rather than interpreting it as shell source.
- Agent-specific direct launchers, including Antigravity event wrappers and
  Copilot's PowerShell-file command, adopt the same missing-file behavior.

## Data Flow

```text
hook runner spawns command
  -> runner writes payload and closes stdin
  -> launcher starts managed script
       -> script consumes payload
       -> refreshes endpoint / evaluates guards
       -> posts or exits zero
  -> OR launcher cannot start script
       -> launcher drains payload
       -> exits zero
```

Local, WSL, and SSH installs serialize the same POSIX template. Windows local
installs use the batch or PowerShell template. No host assumes another host's
path syntax or shell.

## Failure Semantics

- Missing Orca environment: consume input, exit zero, emit only protocol-required
  output.
- Empty payload: consume EOF, then follow the agent's existing empty-event rule.
- Missing/unreadable/non-executable script: launcher consumes input and exits
  zero.
- Endpoint parse/read failure: preserve the existing fail-open behavior after
  stdin ownership has been satisfied.
- Existing script returns nonzero: propagate its status; do not drain again or
  disguise the script failure.
- Hook runner never closes stdin: the existing config-level timeout terminates
  the hook. Reading to EOF does not introduce an unbounded lifecycle beyond that
  already required by normal payload parsing.

## Verification

Add one cross-agent lifecycle suite rather than per-service string-position
assertions.

- Generate every SSH-compatible POSIX managed script, spawn it with Orca
  environment removed, write a payload larger than pipe buffers, and assert:
  exit zero, no stdin error, and required protocol output remains valid.
- Exercise the Claude Devin skip independently because it is a second no-op
  condition before endpoint forwarding.
- Exercise POSIX, encoded PowerShell, cmd.exe, and Git Bash missing-script
  launchers with a large payload and verify zero write errors.
- On Windows CI, install and execute every local batch/PowerShell managed script
  with missing Orca environment and a large payload.
- Keep structural assertions for shared batch guard/epilogue generation, but do
  not use substring placement as the primary regression gate.
- Preserve existing successful-post, timeout, quoting, SSH install, WSL, and
  nonzero-exit propagation tests.

For a macOS smoke test, launch the real Electron app with an isolated `HOME`
and `ORCA_DEV_USER_DATA_PATH`, record the launch time, then run:

```sh
node config/scripts/verify-agent-hook-stdin-lifecycle.mjs \
  --home "$ISOLATED_HOME" \
  --min-mtime "$LAUNCH_START_MS"
```

The verifier rejects stale files, then exercises the 12 POSIX scripts written
by that Electron launch with a payload larger than pipe buffers. It covers
successful no-ops, loopback forwarding without payload changes, required JSON
stdout, Claude's Devin skip, and both branches of the installed missing-script
launcher.

## Rollout And Compatibility

The generated scripts are rewritten by existing install/update flows, so no
config migration is needed. Commands use POSIX `sh` primitives, Windows inbox
executables, and PowerShell features available on supported Windows releases.
No Git behavior or provider-specific review behavior changes.

The change should ship atomically across templates and launchers. A partial
rollout would leave global hooks with platform- or agent-dependent pipe safety,
which is the inconsistency this design removes.
