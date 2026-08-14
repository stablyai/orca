# Windows setup-runner shell

On native Windows, Orca writes the `orca.yaml` setup script (and the issue command) to a generated
runner file and types a launch command into a terminal. The runner is a **`.cmd` batch file by
default**, exactly as it has been since setup hooks shipped.

A script opts into bash by starting with a `#!` interpreter line:

```yaml
scripts:
  setup: |
    #!/usr/bin/env bash
    [ -f .env ] || cp .env.example .env
    pnpm install
```

Without that line the script keeps running under `cmd.exe`:

```yaml
scripts:
  setup: |
    copy .env.example .env
    xcopy /E assets dist
```

## Why the script declares it, not the terminal preference

`terminalWindowsShell` says which shell *interactive terminals* open in. It says nothing about the
language a project's setup script is written in. Deriving the runner from it had two consequences:

- Windows users with batch-syntax setup scripts silently switched to bash on upgrade, so `copy`,
  `xcopy`, `set VAR=value`, and `if errorlevel 1` stopped working.
- Two people on the same repo got different interpreters for the same `orca.yaml`, so no project
  could write a setup script that worked for all of its Windows contributors.

A `#!` line is per-project, explicit, and identical for everyone who checks the repo out.

The same rule applies to the per-user setup command in **Settings → repository hooks**
(`repo.hookSettings.scripts.setup`): it is merged into the same script that reaches the runner, so a
POSIX one-liner stored there needs its own `#!` line to run under bash on Windows.

## What the `#!` line does and does not select

The generated runner is always executed by bash (`bash <runner>`; Git Bash on native Windows), on
every platform. The `#!` line therefore does two things:

- It declares the script is written for a POSIX shell, which is what selects the bash runner.
- Its option flags are replayed with `set`, so `#!/usr/bin/env -S bash -euo pipefail` really does
  get `pipefail`. Without that replay the flags would be silently dropped, because `bash <runner>`
  never parses the interpreter line. Only the flags `set` itself accepts
  (`[--abefhkmnptuvxBCHP] [-o option]`) are replayed; invocation-only ones such as `-l` are
  dropped, because `set -l` exits 2 and would abort the runner before its first line.

The interpreter name itself is not honored beyond "is this a POSIX shell": `#!/bin/sh` and
`#!/bin/zsh` scripts run under bash, exactly as they already did on macOS and Linux.

## Requirements for the bash runner

A `#!` line only takes effect when Orca can actually launch bash from the configured terminal — the
terminal shell must resolve to Git Bash (`resolveWindowsGitBashShellPath`). The generated runner
uses MSYS `/c/...` paths, which Cygwin and the WSL shim do not accept, and the launch command is
typed into whatever shell the terminal opened with.

When bash is not available (a PowerShell/cmd terminal, or an SSH-to-Windows host, which always uses
the remote's `.cmd` runner) the `#!` script is **not** executed under cmd. The generated `.cmd`
runner prints why and exits 1, because running the interpreter-agnostic prefix of a bash script
(`pnpm install`, `git submodule update`) and only failing at the first bash-only line leaves a
half-set-up worktree that looks finished.

## Launching a `.cmd` runner from a Git Bash terminal

The runner format and the shell that types the launch command are independent: a Git Bash terminal
with a batch-syntax setup script gets a `.cmd` runner launched from a bash pane. `cmd.exe /c
"C:\..."` cannot be used there — MSYS rewrites the bare `/c` switch into a drive path, so cmd opens
interactively and the runner never executes (issue #6896). Those launches reuse the PowerShell
`ProcessStartInfo` launcher (`buildWindowsCmdRunnerDelayedLaunchCommand`), which carries the switch
and the runner path outside the command line. `WorktreeSetupLaunch.shell` therefore describes the
launching pane; the runner file's `.cmd`/`.sh` extension describes the format.

The `wait-for-setup` gate follows the same split. The pane types the gate and already quoted the
agent startup command for itself, so a `.cmd` runner launched from a Git Bash pane still gets the
bash gate — PowerShell's `Invoke-Expression` cannot parse POSIX `'\''` escaping. The gate wraps the
same `ProcessStartInfo` launcher, so the batch runner is never handed to bash.

WSL worktrees and non-Windows platforms are unaffected: they always use the bash runner. SSH hosts
choose their runner from the remote path format, never from local Windows preferences.
