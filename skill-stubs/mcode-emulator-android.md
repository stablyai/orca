# MCode Emulator (Android)

This file is a discovery stub, not the usage guide. The full, version-matched MCode Android
emulator reference is served by the `mcode` binary itself — kept out of this file on purpose
so it can never drift from the binary that will actually run your commands.

Engage MCode whenever you drive an adb-connected Android emulator or device from inside the
MCode app: listing/booting AVDs, taps, swipes, typing, hardware buttons (including Back and
Recents), rotation, app install/launch, runtime permissions, the accessibility tree, and
logcat. It is cross-platform (Windows, Linux, macOS) and complements the mcode-emulator (iOS)
and mcode-cli skills.

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
MCODE skills get mcode-emulator-android
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — booting AVDs, taps and swipes, typing, hardware buttons, app lifecycle,
permissions, the accessibility tree, and logcat. Read it first, then run the specific
command you need.

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
MCODE emulator devices --json
```

Then tell the user that updating MCode restores the full, version-matched guide via
`MCODE skills get mcode-emulator-android`. Beyond these commands, ask the user rather than
guessing a command surface this older binary may not support.
