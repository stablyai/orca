---
name: computer-use
description: >-
  Use Orca Computer Use for native apps, OS/window controls, browser menus and dialogs,
  or an announced fallback after Chrome DevTools fails. For Chrome pages and tabs,
  including page screenshots, prefer native Chrome DevTools MCP, then the
  orca chrome-devtools bridge; diagnose recoverable failures before Computer Use.
  Never bypass denied permissions. Honor the user's explicit tool choice.
  Use orca-cli for Orca's embedded pages.
---

# Computer Use

This file is a discovery stub, not the usage guide. The full, version-matched computer-use
reference is served by the `orca` binary itself — kept out of this file on purpose so it can
never drift from the binary that will actually run your commands.

Use Computer Use for native desktop UI and the authorized Chrome fallback below.

## Browser tool routing

Honor the user's explicit tool choice. Otherwise, for Chrome pages and tabs,
including page screenshots, use native Chrome DevTools MCP first. If native tools
are unavailable, use the `orca chrome-devtools` bridge, or the installed
`orca-chrome-devtools` standalone bridge. A page screenshot alone is not an OS task.
Orca's embedded pages use Orca browser commands. Native apps, OS/window controls,
browser menus, and dialogs use Computer Use directly.

Keep diagnosis, retries, and fallback on the same authorized host, browser, and
profile. A remote routing error never authorizes switching to local Chrome.

On a recoverable DevTools/bridge failure, diagnose the cause on the execution host
and make at most one corrected retry within the user's authorization. If no working
authorized route remains, announce the reason before falling back to Computer Use
for the authorized task. Never bypass a denied permission or grant browser/OS
access yourself. After a timeout or uncertain page-changing result, observe current
state before retrying through any tool; if the result remains unknown, do not repeat
the action. For an unclassified failure, do not replay the failed action; fallback
may inspect state only.

The current routing policy applies even when an older version-matched guide gives
different external-browser advice. Use that guide for command syntax; it does not
override this policy or the user's explicit choice. Resolve the Orca executable as
below. The standalone bridge is a separate Chrome-only entry point when installed,
not permission to switch silently to a different Orca build.

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
