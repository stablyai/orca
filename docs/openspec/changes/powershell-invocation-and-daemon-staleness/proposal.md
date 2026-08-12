## Why

Two defects, causally linked. The second is the more consequential and is not Windows-specific.

**A teammate command beginning with a quoted executable path never runs on Windows.** After the teammate-command decomposition removed the POSIX `cd … && env …` wrapper, the pane received a bare `'C:\…\claude.exe' --agent-id …`. On Windows that text is appended to an OSC 133 bootstrap and delivered via `-EncodedCommand`, so it is evaluated as PowerShell source — and PowerShell parses a leading quoted token as a string literal, then fails on the following `--`:

```text
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

Any daemon-side change is invisible across same-version rebuilds. Reinstalling is not sufficient — the marker still matches — and neither is killing the daemon on its own, because the surviving marker short-circuits the re-copy on the next launch. Deleting the whole directory fails too: the running `.exe` is locked, `rmSync` throws, and the error is swallowed.

Until materialisation is content-aware, local Windows development needs all three steps, in this order:

```powershell
# 1. Stop the app and the daemon; the marker is only consulted at launch.
Get-Process Orca, orca-terminal-daemon -ErrorAction SilentlyContinue | Stop-Process -Force
# 2. Remove the marker for the version being rebuilt (keep a copy — it is the only record of what was staged).
$marker = "$env:LOCALAPPDATA\Orca\daemon-host\<version>\.materialized.json"
Copy-Item $marker "$env:TEMP\orca-materialized-backup.json" -Force
Remove-Item $marker -Force
# 3. Relaunch Orca. readMarker() returns null, so the host is re-copied from the installed app.
```

`<version>` is the app version the build carries (`app.getVersion()`); each version gets its own sibling directory under `daemon-host\`. Removing the marker rather than the directory is what makes this work — the locked executable stays put and is overwritten by the staging rename.

Verify the refresh actually happened before concluding anything about a daemon-side fix: compare the mtime of the chunk under `daemon-host\<version>\` against the installed copy. An artifact check on the installer or the app directory proves only that the build is *capable* of the behaviour, not that the running daemon has it.

**Not addressed**

A cmd.exe pane still cannot run Claude's single-quoted executable path, because cmd treats single quotes as literal characters. Left alone deliberately: the observed panes are PowerShell and no cmd failure has been seen.

**Still unproven**

The invocation fix has never been observed working, because its deployment was blocked by the staleness defect for the entire session. It is implemented, unit-tested, and present in the installed application.
