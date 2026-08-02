---
name: computer-use
description: >-
  Use Orca's computer-use CLI to inspect and operate local desktop app windows
  through accessibility trees, screenshots, and safe UI actions. Use for
  desktop app interaction: list apps/windows, get app state, read visible UI,
  click controls, type, press keys, scroll, drag, set values, or perform
  accessibility actions. Also use for browser windows, webviews, Orca app UI,
  or other desktop UI. Triggers include "computer use", "orca computer", "read
  Spotify", "read Slack", "control/click/read in a desktop app", and "get app
  state".
---

# Computer Use

This file is a discovery stub, not the usage guide. The full, version-matched computer-use
reference is served by the `orca` binary itself — kept out of this file on purpose so it can
never drift from the binary that will actually run your commands.

Engage Orca's computer-use surface whenever you must inspect or operate a local desktop app
window — reading its accessibility tree, taking screenshots, or performing safe UI actions
(click controls, type, press keys, scroll, drag, set values). It also covers browser
windows, webviews, and Orca's own UI. Triggers include "computer use", "orca computer",
"read Spotify", "read Slack", "control/click/read in a desktop app", and "get app state".

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

## Load the full guide before running Orca commands

```text
ORCA skills get computer-use
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — listing apps/windows, reading UI, and driving clicks, typing, and other
accessibility actions. Read it first, then run the specific command you need.

Don't guess subcommands or flags from memory or from a cached copy of this stub. They
change between Orca releases, and this file deliberately no longer lists them. Confirm the
app is up with `ORCA status --json` (start it with `ORCA open --json` if needed), and
prefer `--json` for agent-driven calls.

## If an older Orca does not recognize `skills get`

Use this fallback only when the selected binary explicitly reports that `skills get` is an
unknown command. Another failure is not proof of an older binary; report it rather than
guessing or changing executables. For a confirmed pre-guide binary, use only this bounded,
read-only bootstrap to orient. Do not dead-end and do not invent commands:

```text
ORCA status --json
ORCA computer capabilities --json
ORCA computer list-apps --json
```

Then tell the user that updating Orca restores the full, version-matched guide via
`ORCA skills get computer-use`. Beyond these commands, ask the user rather than guessing a
command surface this older binary may not support.
