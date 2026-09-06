---
name: computer-use
description: >-
  OS/window-level inspection and input in visible local app windows through `orca computer`:
  native apps, external browser windows (Chrome, Edge, Safari), and app webviews. Not for
  Orca's embedded browser (use `orca-cli`) or page-only automation (use Playwright or CDP).
---

# Computer Use

This file is a discovery stub, not the usage guide. The full, version-matched computer-use
reference is served by the `orca` binary itself — kept out of this file on purpose so it can
never drift from the binary that will actually run your commands.

Engage Orca's computer-use surface when a task requires desktop-level access to a visible local
app or window, including a native app or an external browser window/webview. Do not use for
Orca's embedded browser or page-only browser automation. Use `orca-cli` for Orca's embedded
pages and a page-automation tool such as Playwright or CDP for external pages.

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

Don't guess subcommands or flags from memory or from a cached copy of this stub. They change
between Orca releases, and this file deliberately no longer lists them. Prefer `--json` for
agent-driven calls. If a command reports that Orca is not running, start it with `ORCA open
--json` and retry. If the binary does not recognize `skills get`, it predates this guide:
tell the user that updating Orca restores it, and ask before running anything else.
