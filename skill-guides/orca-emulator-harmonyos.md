---
name: orca-emulator-harmonyos
description: >-
  HarmonyOS emulator and device control from inside Orca over hdc, with the
  live device view in Orca's emulator pane. Use when driving a DevEco Studio
  local emulator or a hdc-connected phone on Windows, Linux, or macOS:
  booting emulator instances, taps, swipes, typing, hardware buttons, rotation,
  HAP install, ability launch, and the accessibility tree. For an iOS
  simulator use the iOS emulator skill, for an Android device the Android
  emulator skill; build the HAP with DevEco Studio first.
license: Apache-2.0
---

# Orca Emulator (HarmonyOS)

`ORCA` is a placeholder for the executable you resolved in the stub; substitute it before running.

## Command surface

The HarmonyOS backend shells out to the DevEco Studio toolchain (`hdc`, `Emulator`), so it
runs on Windows, Linux, and macOS. The live view is produced by polling `hdc shell
snapshot_display` through a local MJPEG relay: the HarmonyOS emulator cannot record video,
so the preview is capped around 7 frames per second.

`ORCA emulator --help` lists the wrapped verbs. Anything else goes through
`ORCA emulator exec --command "<shell command>"`, which runs
`hdc -t <connectKey> shell <command>` with the string unvalidated.

`permissions` and `logcat` are Android-only; HarmonyOS fails them with `emulator_unsupported`.
`tap`, `type`, `gesture`, `button`, `rotate`, `ax`, `exec`, `install`, and `launch` work,
with backend-specific output for `ax` — a `uitest` node tree on HarmonyOS.

Device control is local to the host that owns the toolchain; remote and SSH device control
is out of scope.

## Prerequisites

- DevEco Studio installed with the HarmonyOS SDK and Emulator. Orca checks
  `HOS_SDK_HOME`, `DEVECO_SDK_HOME`, and the per-OS default locations
  (`%LOCALAPPDATA%\Huawei\Sdk`, `/Applications/DevEco-Studio.app/Contents`,
  `~/Huawei/Sdk`); a path can also be set in Orca's Mobile Emulator settings.
- At least one emulator instance (DevEco Studio ▸ Device Manager) or a device with USB
  debugging visible to `hdc list targets`.
- A booted, hdc-visible target before any input or capability command. A shutdown instance
  is listed with `state: shutdown` and is started by `ORCA emulator attach` — Orca runs
  `Emulator -start <name> -hdcPort <port>` and waits for the target to appear.

Some emulator images are bound to the signed-in Huawei account and can only be started from
DevEco Studio; start them there and let Orca attach. Orca returns a clear message when the
toolchain is missing (`HarmonyOS toolchain not found. Install DevEco Studio with the
HarmonyOS SDK and Emulator.`).

## Operations

Use `--json` for agent-driven calls. Unqualified commands target the worktree's active
device.

| Goal                   | Command                                                               | Constraint                                                                                    |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| List instances/targets | `ORCA emulator devices --json`                                        | Every backend's devices with a platform column, booted and shutdown.                          |
| Attach / make active   | `ORCA emulator attach "Mate 90 Pro" --json`                           | Given a shutdown instance name, boots it first. Makes the target active for the worktree.     |
| Single tap             | `ORCA emulator tap <x> <y> --json`                                    | Normalized 0..1 coordinates.                                                                  |
| Swipe / gesture        | `ORCA emulator gesture '<json>' --json`                               | Sent through `uinput` between the first and last points.                                      |
| Type text              | `ORCA emulator type "user@example.com" --json`                        | US-ASCII, needs a focused input field.                                                        |
| Hardware button        | `ORCA emulator button back --json`                                    | `home`, `back`, `recents`, `power`, `volume_up`, `volume_down`.                               |
| Rotate                 | `ORCA emulator rotate landscape_left --json`                          | Drives `Emulator -instance <name> -rotation`.                                                 |
| Install a HAP          | `ORCA emulator install ./entry-default-signed.hap --reinstall --json` | `--reinstall` passes `-r`.                                                                    |
| Launch an ability      | `ORCA emulator launch com.acme.app --activity EntryAbility --json`    | Omit `--activity` to launch the default `EntryAbility`.                                       |
| Accessibility tree     | `ORCA emulator ax --json`                                             | `uitest dumpLayout` parsed to a node tree, frames 0..1, capped at 500 nodes.                  |
| Raw hdc shell          | `ORCA emulator exec --command "bm dump -n com.acme.app" --json`       | Runs `hdc -t <connectKey> shell <command>`.                                                   |
| Stop the helper        | `ORCA emulator kill --json`                                           | Leaves the target booted.                                                                     |
| Stop and power off     | `ORCA emulator shutdown --json`                                       | Stops the helper and runs `Emulator -stop <name>`.                                            |

## Targeting

`attach`, or opening the emulator pane, makes one target active per worktree, and
unqualified commands target it. Pass a selector only to override that or reach a second
device.

- `--device <connectKey>` such as `127.0.0.1:5555`, from `ORCA emulator devices`. An
  instance name resolves once that instance is booted.
- `--emulator <id>` is an alternative spelling of `--device`: the bridge resolves both
  through the same device lookup.
- `--worktree id:<fullWorktreeId>` or `--worktree active`. The full id is the exact
  `<repo-id>::<path>` value returned by `ORCA worktree list --json`; a bare repo id is not
  valid here.
- `--worktree all` drops worktree scoping on every verb, not only on listing, so a mutating
  command passed `all` runs unscoped. Use it only for listing.
- `ORCA emulator devices` is global and lists every backend; the other verbs route to the
  backend that owns the resolved target.

## Constraints

- All coordinates are normalized 0..1 with a top-left origin, never pixels. Orca scales
  them to the instance's configured resolution.
- Prefer `tap` over `gesture` for a single tap.
- `type` uses `uitest uiInput text` and needs a focused text field; US-ASCII only.
- `gesture` is a straight swipe between the first and last point, so it fits scrolling and
  swiping but not a true multi-touch path.
- The preview is snapshot polling at roughly 7fps; it is an inspection view, not smooth
  video. Input works independently of frame rate.
- Physical devices and account-bound emulator images cannot be booted, rotated, or shut
  down from Orca; attach to them after they are running.
- Run `kill` when you are done. A helper left running holds the target until Orca quits.

## Examples

```text
ORCA emulator devices --json
ORCA emulator attach "Mate 90 Pro" --json
ORCA emulator tap 0.5 0.85 --json
ORCA emulator type "hello world" --json
ORCA emulator button home --json
ORCA emulator rotate landscape_left --json
ORCA emulator install ./entry-default-signed.hap --reinstall --json
ORCA emulator launch com.acme.app --json
ORCA emulator ax --json
ORCA emulator exec --command "bm dump -n com.acme.app" --json
ORCA emulator kill --json
```

See also: `orca-emulator` for iOS simulators, `orca-emulator-android` for Android devices,
`orca-cli` for terminals, worktrees, and the built-in browser, and `computer-use` for
desktop UI outside the emulator.
