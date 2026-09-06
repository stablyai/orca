<!-- Single-authored blocks shared by every skill-stubs/<topic>.md projection.
     Insert one with a line reading `<!-- shared: <id> -->`; every block below must be
     inserted exactly once by every stub. `reflow` re-wraps the block after {{topic}}
     substitution, because the substituted name changes where the lines break. -->

<!-- block: resolver -->

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `ORCA_CLI_COMMAND` environment variable is set, use its value. Orca exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `ORCA_DEV_REPO_ROOT`, use `orca-dev`.
- Otherwise, on Linux outside an Orca-managed terminal, use `orca-ide`. Never run bare
  `orca` there — outside Orca's terminals it normally resolves to the
  GNOME Orca screen reader (`/usr/bin/orca`) and starts speech on the user's machine.
- Otherwise, use `orca`.

Below, `ORCA` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `ORCA` literally. This works the
same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different Orca build.

<!-- block: no-guessing -->

Don't guess subcommands or flags from memory or from a cached copy of this stub. They change
between Orca releases, and this file deliberately no longer lists them. Prefer `--json` for
agent-driven calls. If a command reports that Orca is not running, start it with `ORCA open
--json` and retry. If the binary does not recognize `skills get`, it predates this guide:
tell the user that updating Orca restores it, and ask before running anything else.
