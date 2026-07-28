## Why

Two defects, causally linked. The second is the more consequential and is not Windows-specific.

**A teammate command beginning with a quoted executable path never runs on Windows.** After the teammate-command decomposition removed the POSIX `cd … && env …` wrapper, the pane received a bare `'C:\…\claude.exe' --agent-id …`. On Windows that text is appended to an OSC 133 bootstrap and delivered via `-EncodedCommand`, so it is evaluated as PowerShell source — and PowerShell parses a leading quoted token as a string literal, then fails on the following `--`:

```
Unexpected token 'agent-id' in expression or statement.
The '--' operator works only on variables or on properties.
```

**The fix for that appeared to do nothing across three reinstall cycles**, because Orca's PTY daemon is materialised into a directory keyed only on the app version string. Local rebuilds all carry the same version, so the marker always matches, materialisation short-circuits, and the daemon keeps executing a bundle copied on a previous day. Measured: the daemon was running a chunk built 27/07 17:38 without the fix, while the installed app carried one built 28/07 10:20 with it — and the daemon process itself had survived every reinstall.

That masking is why the first defect took three attempts to land, and it will silently swallow any future daemon-side change made during local development.

## What Changes

- Prefix the PowerShell call operator when a startup command begins with a quoted token, at the layer that knows the pane's shell.
- Record the daemon-host staleness defect and propose keying materialisation on daemon-source content rather than the version string alone.

## Capabilities

### New Capabilities

- `windows-shell-command-invocation`: how a startup command supplied by Orca or relayed from an external tool is made executable by the pane's shell on Windows.
- `daemon-host-materialization`: when the relocated PTY daemon is refreshed from the installed application, and what must change for a refresh to occur.

### Modified Capabilities

<!-- None. Both are newly recorded behaviours. -->

## Impact

**Code**

- `src/main/providers/windows-shell-args.ts` — `ensurePowerShellInvocable`, applied in `getPowerShellEncodedCommand`
- `src/main/providers/windows-shell-args.test.ts` — invocability coverage, including commands that must be left alone

**Not changed**

`src/main/daemon/daemon-host-relocation.ts`. The staleness defect is diagnosed and specified here, but no code change was made — the local instance was unblocked by removing the stale marker by hand.

**Deployment**

Any daemon-side change is invisible across same-version rebuilds. Until materialisation is content-aware, local Windows development needs an explicit refresh: stop the daemon, remove the marker, relaunch. Reinstalling is not sufficient, and neither is killing the daemon on its own.

**Not addressed**

A cmd.exe pane still cannot run Claude's single-quoted executable path, because cmd treats single quotes as literal characters. Left alone deliberately: the observed panes are PowerShell and no cmd failure has been seen.

**Still unproven**

The invocation fix has never been observed working, because its deployment was blocked by the staleness defect for the entire session. It is implemented, unit-tested, and present in the installed application.
