---
name: mcode-emulator
description: >
  Control a mobile (iOS) emulator / simulator stream from inside MCode using the `mcode` CLI.
  Use for taps, gestures, typing, hardware buttons, camera injection, permissions, accessibility tree, and more — all while seeing the live view in MCode's emulator pane.
  Prefer this over raw `npx serve-sim` or direct simctl when running agents inside MCode (the mcode surface handles device scoping, helper lifecycle, and worktree context).
  Complements the mcode-cli skill for terminals, worktrees, and the built-in browser.
license: Apache-2.0
---

# MCode Emulator (serve-sim powered)

Drive an Apple Simulator (iOS / iPad / Watch) **from within MCode** using `MCODE emulator ...` commands (or `MCODE emulator exec` for raw power). This wraps the excellent [serve-sim](https://github.com/EvanBacon/serve-sim) open-source tool so agents get a consistent MCode-native CLI surface, automatic helper management, and seamless integration with MCode's live emulator pane (the visual "preview" surface).

The underlying serve-sim helper captures the real simulator framebuffer (via private SimulatorKit / IOSurface for low-latency 60fps H.264 or MJPEG) and exposes a WebSocket control channel. MCode's bridge owns the helper processes and per-worktree "active emulator" state so unqualified commands "just work" on whatever device/pane is current for the worktree.

## CLI executable

Choose the MCode executable once: use the `MCODE_CLI_COMMAND` environment value when set;
otherwise use `mcode-dev` in a dev session exposing `MCODE_DEV_REPO_ROOT`, `mcode-ide` on
Linux outside an MCode-managed terminal, and `mcode` everywhere else. Never try bare
`mcode` first on unmanaged Linux because it normally resolves to the GNOME screen reader.

In every command example — fenced blocks, tables, and prose — `MCODE` is a documentation
placeholder. Replace it with the chosen executable before running the command; do not
create a shell variable or run `MCODE` literally. The command examples are intentionally
shell-neutral for POSIX shells, PowerShell, and cmd.exe.

## When to use

- The user/agent wants to **tap, swipe, drag, pinch, or press hardware buttons** on a running iOS simulator while seeing the live result in MCode.
- You want **camera injection** (placeholder, webcam, or file loop) for testing camera flows.
- You need to **grant/revoke app permissions** (camera, photos, notifications, location, etc.) or read the **accessibility tree**.
- Rotate the device, simulate memory warnings, toggle CoreAnimation debug overlays, etc.
- You are inside an MCode worktree/terminal and want the emulator to be **workspace-scoped** (like browser tabs) with explicit targeting when needed.
- The agent should use MCode's preview pane instead of external Simulator.app or raw serve-sim URLs.

**When NOT to use**
- Android emulators → use the `mcode-emulator-android` skill (same `MCODE emulator` namespace, cross-platform via adb/emulator).
- Building or installing the app itself → use `xcodebuild`, `xcrun simctl install`, `expo run:ios`, etc. (launch the app, then use `MCODE emulator` to drive it).
- In-app debugging (state, network, views) → use the app's own tools or the browser pane if it's a webview.
- Remote/SSH worktrees for emulator control (currently out of scope / unsupported; simulator hardware is local to a Mac).

## Prerequisites (enforced / surfaced by MCode)

- macOS host (with Xcode Command Line Tools: `xcrun --version`).
- A booted simulator (`xcrun simctl list devices booted` or let MCode/attach help boot one).
- Node available (for the serve-sim bits; MCode bundles the CLI surface).
- macOS 14+ recommended for full camera injection features.

MCode will give clear errors if these are missing (e.g. "emulator commands require macOS + Xcode tools").

An active emulator "session" for the worktree is required for most commands. Use `MCODE emulator list` / `attach` or open the emulator pane in the UI.

## Mental model

```text
┌────────────────────┐
│ MCode worktree      │
│  - active emulator │◄── MCODE emulator tap / type / ...
│  - live pane (UI)  │
└─────────┬──────────┘
          │ (registers active stream)
          ▼
┌────────────────────┐   WS / control   ┌─────────────────┐  framebuffer  ┌──────────────┐
│ MCode EmulatorBridge│ ───────────────► │ serve-sim-bin   │ ────────────► │ iOS Simulator│
│ (main process)     │ (or exec serve-sim) (per-device)   │               └──────────────┘
└────────────────────┘                  └─────────────────┘
          ▲
          │ (state + lifecycle)
┌────────────────────┐
│ mcode CLI (agents)  │  e.g. MCODE emulator tap 0.5 0.7
│ mcode-emulator skill│
└────────────────────┘
```

MCode owns:
- Starting/stopping the serve-sim helper (via --detach or direct).
- Per-worktree "active" emulator (like active browser tab).
- Explicit targeting with `--worktree`, `--device`, `--emulator <id>`.
- The visual live pane (renderer uses serve-sim-client for the stream).

Agents use the MCode executable chosen above (on PATH in MCode terminals) and never have to manage PIDs, state files in /tmp, or raw WS URLs themselves.

**For `pnpm dev` testing:** run `pnpm build:cli` first (rebuilds the CLI + ensures the `mcode-dev` shim points at *this* worktree). Then inside the dev app use `mcode-dev emulator ...` (or the direct `./config/scripts/mcode-dev.mjs emulator ...` from the repo root). The orchestration preambles and dev launchers automatically select the dev command name so the CLI reaches your in-memory EmulatorBridge / runtime. Plain `mcode` reaches a packaged install instead.

## Common operations

Use `--json` for agent-friendly output. Commands are workspace-scoped by default (current worktree's active emulator).

| Goal                        | Command                                      | Notes |
|-----------------------------|----------------------------------------------|-------|
| List available / running   | `MCODE emulator list [--worktree <sel>]`     | Shows MCode-managed + raw serve-sim streams. Use output for explicit --device/--emulator. |
| Attach / make active       | `MCODE emulator attach "iPhone 16 Pro" [--worktree <sel>] [--focus]` | Starts helper if needed (serve-sim --detach). Sets active for unqualified commands. --focus optional (does not auto-steal UI focus by default). |
| Single tap                 | `MCODE emulator tap <x> <y> [--device <id>]` | Normalized 0..1 coords. **Preferred over gesture for simple taps.** |
| Multi-step gesture         | `MCODE emulator gesture '<json>'`            | See gestures reference (begin/move/end). Use tap for singles. |
| Type text                  | `MCODE emulator type "text" [--device <id>]` | US ASCII only. Supports stdin/file via exec if needed. |
| Hardware button            | `MCODE emulator button home [--device <id>]` | home, swipe_home, app_switcher, lock, siri, side_button. |
| Rotate device              | `MCODE emulator rotate landscape_left`       | Remembers orientation for subsequent gestures. |
| Camera injection           | `MCODE emulator camera com.acme.App --webcam` | Or --file, placeholder. Hot-swap with switch. May (re)launch app. |
| Permissions                | `MCODE emulator permissions grant camera com.acme.App` | grant/revoke/reset/list. See full subcommand help. |
| Accessibility tree         | `MCODE emulator ax [--device <id>]`          | Raw serve-sim AX node tree (labels, roles, nested children, capped at 500 nodes; frames normalized 0..1 with top-left origin — tap an element at its frame center: x+width/2, y+height/2). Needs an active session. |
| Raw / advanced             | `MCODE emulator exec --command "tap 0.5 0.7"` | Or "ca-debug blended on", "memory-warning", full serve-sim subcommands (no "serve-sim" prefix needed in the command string). Bridge injects active device context. |
| Stop                       | `MCODE emulator kill [--device <id>]`        | Or let pane close / MCode quit clean up. |

Most support `--worktree <selector>` and explicit `--device <udid|name>` or `--emulator <id>` (from list) for targeting.

## Critical gotchas (teach agents)

- **Prefer `tap` over `gesture` for single taps** (same as raw serve-sim). Separate gesture begin/end can be interpreted as long-press due to WS overhead. The MCode wrapper uses the reliable quick sequence.
- All coords normalized 0..1 (top-left origin). Never pixels.
- One "active" emulator per worktree for unqualified commands (like active browser tab). Discover ids with `list`, use explicit flags for multi-device or cross-worktree.
- Type = US keyboard only. Unsupported chars error clearly.
- Camera injection often requires (re)launching the target app bundle.
- The visual pane and CLI share the same underlying stream/helper. Closing the pane can stop the stream (configurable).
- Stale helpers / state are cleaned by MCode on quit, but agents should `kill` when done.
- Private APIs under the hood (SimulatorKit etc.) — version sensitive (Xcode updates can affect).

## Targeting devices & worktrees

- Default: current worktree's active emulator (resolved from shell cwd or MCode context).
- Explicit worktree: `--worktree id:<fullWorktreeId>` or `--worktree active`. The full id is the exact `<repo-id>::<path>` value returned by `MCODE worktree list --json`; a bare repo id is not valid here.
- Explicit device: `--device "iPhone 16 Pro"` or `--device <udid>` (after `list`).
- MCode-generated emulator id (for stability, like browserPageId): use `--emulator <id>` returned by list (recommended for scripts that persist ids).

`--worktree all` only for listing.

## Integration with the live pane (UI)

- Opening the emulator pane in MCode (or `attach`) makes that stream the "active" one for the worktree → CLI commands target it automatically.
- The pane shows the real 60fps stream (device frame, touch forwarding, toolbar).
- Agents can drive via CLI while the human watches/interacts in the pane.
- No automatic focus steal on CLI attach (use `--focus` if you really want the UI to switch; matches browser behavior).
- Multiple devices: list shows them; pane can grid; CLI uses active or explicit selector.

## Cleanup

```text
MCODE emulator kill --device "iPhone 16 Pro"
```

Or let MCode quit / close the pane.

Orphans are cleaned by MCode (like agent-browser sessions).

## Examples (agent-friendly)

```text
MCODE status --json
MCODE emulator list --json
MCODE emulator attach "iPhone 16 Pro" --json
MCODE emulator tap 0.5 0.8 --json
MCODE emulator type "user@example.com" --json
MCODE emulator button home --json
MCODE emulator camera com.acme.MyApp --file /tmp/test.mp4 --json
MCODE emulator permissions grant camera com.acme.MyApp --json
MCODE emulator ax --json
MCODE emulator exec --command "ca-debug blended on" --json
```

After changes, re-snapshot / wait as needed (analogous to browser snapshot-interact loop).

## Next action

Confirm `MCODE status --json` and `MCODE emulator list --json`, then drive the emulator while the live view is visible in MCode.

See also: mcode-cli skill (terminals, worktrees, built-in browser), computer-use for desktop outside the simulator.

This skill is the MCode-native replacement for raw serve-sim when you want the visual + control integrated in the IDE.
