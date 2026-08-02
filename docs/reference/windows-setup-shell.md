# Windows Setup Shell

## Release note

**Git Bash terminals now run `orca.yaml` setup under bash.** If your Windows
terminal shell is set to Git Bash, Orca writes the setup and issue-command
runners as `.sh` scripts and launches them with Git Bash instead of `cmd.exe`.
Setup content written in batch syntax (`call`, `%VAR%`, `if errorlevel`) must be
ported to bash, or the terminal shell switched back to PowerShell or cmd.

## Scope

Setup shell selection is narrower than the terminal shell setting:

| Configured Windows shell | Setup / issue-command runner |
| --- | --- |
| Git Bash (resolvable install) | POSIX `.sh`, launched with Git Bash |
| WSL-routed project runtime | POSIX `.sh`, launched via `wsl.exe` with `/mnt/...` paths |
| PowerShell, pwsh, cmd.exe | `.cmd` (unchanged) |
| `wsl.exe` as terminal on a Windows-host project | `.cmd` (unchanged) |
| Non-Git bash (Cygwin, MSYS2), bare `bash` | `.cmd` (unchanged) |
| Remote Windows over SSH | `.cmd` (local shell setting is not consulted) |

Existing setup scripts keep working on every row that stays on `.cmd`, which is
every configuration except Git Bash and WSL.

## Resolution rules

`resolveSetupRunnerShell` returns the POSIX runner only when the configured
shell resolves to an installed Git-for-Windows `bash.exe`. Resolution existence-
checks the executable — a configured path pointing at an uninstalled or moved
Git Bash falls back to the cmd runner rather than committing setup to a shell
the PTY cannot spawn.

Setup and issue-command runners resolve the same shell, so one session never
mixes a bash setup runner with a cmd issue runner.

`ORCA_*` environment paths are converted to Linux form for WSL worktrees only;
native Git Bash runners still receive Windows-form paths.
