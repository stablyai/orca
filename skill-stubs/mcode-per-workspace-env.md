# Per-Workspace Environments

This file is a discovery stub, not the usage guide. The full, version-matched per-workspace
environment reference is served by the `mcode` binary itself — kept out of this file on
purpose so it can never drift from the binary that will actually run your commands.

Engage MCode whenever you set up, review, debug, or validate a per-workspace environment
recipe — the on-demand, disposable runtimes (cloud sandboxes, VMs, or local) created fresh
for each workspace. This covers first-time setup (provider prerequisites, the reusable base
snapshot, the coding-agent auth snapshot, credentials, and state), not just the
per-workspace lifecycle scripts. Use it to stand up per-workspace environments, fix an
`environmentRecipes` entry in `mcode.yaml`, scaffold provider lifecycle scripts, or resolve
an `mcode vm recipe doctor` failure. MCode is a thin wrapper: you guide, detect, and scaffold;
you never own the user's cloud account, billing, images, or credentials, and never spend
money without an explicit user OK.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `MCODE_CLI_COMMAND` environment variable is set, use its value. MCode exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `MCODE_DEV_REPO_ROOT`, use `mcode-dev`.
- Otherwise, on Linux outside an MCode-managed terminal, use `mcode-ide`. Never run bare
  `mcode` there — outside MCode's terminals it normally resolves to the
  GNOME MCode screen reader (`/usr/bin/mcode`) and starts speech on the user's machine.
- Otherwise, use `mcode`.

Below, `MCODE` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `MCODE` literally. This works the
same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different MCode build.

## Load the full guide before running MCode commands

```text
MCODE skills get mcode-per-workspace-env
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — provider setup, base and auth snapshots, `environmentRecipes` in
`mcode.yaml`, lifecycle scripts, and `mcode vm recipe doctor`. Read it first, then run the
specific command you need.

Don't guess subcommands or flags from memory or from a cached copy of this stub. They
change between MCode releases, and this file deliberately no longer lists them. Confirm the
app is up with `MCODE status --json` (start it with `MCODE open --json` if needed), and
prefer `--json` for agent-driven calls.

## If an older MCode does not recognize `skills get`

Use this fallback only when the selected binary explicitly reports that `skills get` is an
unknown command. Another failure is not proof of an older binary; report it rather than
guessing or changing executables. For a confirmed pre-guide binary, use only this bounded,
read-only bootstrap to orient. Do not dead-end and do not invent commands:

```text
MCODE status --json
MCODE vm recipe doctor <recipe-id> --repo-path <repo> --json
```

The doctor command above is the free static check. Never add `--provision` without the
user's explicit approval because it creates provider resources and may spend money.

Then tell the user that updating MCode restores the full, version-matched guide via
`MCODE skills get mcode-per-workspace-env`. Beyond these commands, ask the user rather than
guessing a command surface this older binary may not support.
