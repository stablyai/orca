# Orca Emulator (Android)

This file is a discovery stub, not the usage guide. The full, version-matched Orca Android
emulator reference is served by the `orca` binary itself — kept out of this file on purpose
so it can never drift from the binary that will actually run your commands.

Engage Orca whenever you drive an adb-connected Android emulator or device from inside the
Orca app: listing/booting AVDs, taps, swipes, typing, hardware buttons (including Back and
Recents), rotation, app install/launch, runtime permissions, the accessibility tree, and
logcat. It is cross-platform (Windows, Linux, macOS) and complements the orca-emulator (iOS)
and orca-cli skills.

<!-- shared: resolver -->

## Load the full guide before running Orca commands

```text
ORCA skills get orca-emulator-android
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — booting AVDs, taps and swipes, typing, hardware buttons, app lifecycle,
permissions, the accessibility tree, and logcat. Read it first, then run the specific
command you need.

<!-- shared: no-guessing -->

<!-- shared: older-binary-intro -->

```text
ORCA status --json
ORCA emulator devices --json
```

<!-- shared: older-binary-outro -->
