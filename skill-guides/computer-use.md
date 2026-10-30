---
name: computer-use
description: >-
  Drives the GUI of a visible local app window through `orca computer`: accessibility
  tree, clicks, typing, menus, dialogs, and screenshots in native apps and external
  browser windows (Chrome, Edge, Safari) or webviews. Prefer a programmatic path
  (shell, filesystem, git, HTTP, existing CLIs) whenever it can complete the task.
  Use only when a visible window needs GUI control those cannot reach. Do not use
  for Orca's embedded browser (`orca-cli`).
---

# Computer Use

Use this skill to drive a visible app window through `orca computer`. Prefer a programmatic path (shell, filesystem, git, HTTP, existing CLIs) whenever it can complete the task; use this skill only when a visible window needs GUI control those cannot reach. Do not use it for Orca's embedded browser (`orca-cli`).

## Preconditions

- `ORCA` is a placeholder for the executable you resolved in the stub; substitute it before running.
- Prefer `--json`; see Screenshots below for image output.
- Do not push, submit forms, send messages, buy items, delete data, change account settings, or expose secrets unless the user explicitly asked for that action.
- If an app contains sensitive content, read only what the user requested.

```text
ORCA computer capabilities --json
```

## Core Loop

```text
ORCA computer list-apps --json
ORCA computer get-app-state --app com.spotify.client --json
ORCA computer click --app com.spotify.client --element-index 42 --json
```

Use the fresh state returned by each action for the next element index. Element indexes are the numeric labels shown in the tree; they may be sparse when noisy sections are omitted, so never infer valid indexes from `elementCount` or "Visible elements." Element indexes are short-lived and go stale after delays, navigation, focus changes, scrolling, window changes, or app re-rendering.

In `--json` output, read the accessibility tree and action indexes from `result.snapshot.treeText`; `elementCount` is only a count and must not be used to infer indexes.

## Reading State Cheaply

Action results omit unchanged elements when their locations stay unambiguous. `result.snapshot.treeDiff` marks a diff, and `treeText` then lists `~` changed element lines, `-` removed indexes as ranges, or "No change in the accessibility tree", followed by the focused element. Elements not listed keep the index and text from the last tree you read. Additions, moves and parent changes return the whole tree so each control's location stays clear. Without `treeDiff`, always read `treeText` as the whole tree; window changes, large diffs and older runtimes can also return full trees. Older runtimes may include `+` added lines in a diff. On macOS an element keeps its index across reads while it exists. Pass `--full-tree` to an action when you need the whole tree back.

In a large window, look for one control with `get-app-state --query <text>`: it prints only elements whose line contains the text (case-insensitive), with their ancestors. `--max-elements <n>` caps how many elements are printed. Both only narrow the output; indexes are the same as in the full tree.

```text
ORCA computer get-app-state --app com.apple.finder --query Downloads --json
```

## App Selectors

Prefer bundle IDs from `list-apps`; names are acceptable when unambiguous. Use `pid:<number>` only when bundle ID or name matching is ambiguous.

```text
ORCA computer get-app-state --app com.microsoft.edgemac --json
ORCA computer get-app-state --app Spotify --json
ORCA computer get-app-state --app pid:12345 --json
```

For apps with multiple windows or ambiguous titles, run `list-windows` first. Prefer `--window-id <id>` when the listed id is not `none`; otherwise use `--window-index <n>`. Once you choose a window, pass the same selector to `get-app-state` and later actions until the target window changes.

## Commands

```text
ORCA computer permissions --json
ORCA computer capabilities --json
ORCA computer list-apps --json
ORCA computer list-windows --app <app> --json
ORCA computer get-app-state --app <app> --json
ORCA computer get-app-state --app <app> --restore-window --json
ORCA computer click --app <app> --element-index <index> --json
ORCA computer click --app <app> --x 100 --y 100 --json
ORCA computer click --app <app> --x 100 --y 100 --modifiers CmdOrCtrl+Shift --json
ORCA computer click --app <app> --element-index <index> --mouse-button right --json
ORCA computer click --app <app> --element-index <index> --mouse-button middle --json
ORCA computer perform-secondary-action --app <app> --element-index <index> --action <name> --json
ORCA computer set-value --app <app> --element-index <index> --value "text" --json
ORCA computer type-text --app <app> --text "text" --json
ORCA computer press-key --app <app> --key Return --json
ORCA computer hotkey --app <app> --key CmdOrCtrl+A --json
ORCA computer paste-text --app <app> --text "text" --json
ORCA computer scroll --app <app> (--element-index <index> | --x <x> --y <y>) --direction down --json
ORCA computer drag --app <app> --from-element-index <index> --to-element-index <index> --json
ORCA computer drag --app <app> --from-x 100 --from-y 100 --to-x 300 --to-y 300 --json
```

Use `--no-screenshot` only when pixels are not needed. Use `--text-stdin` or `--value-stdin` for sensitive text so payloads do not land in shell history. On Linux and Windows, action payloads still pass through a short-lived local operation file, so avoid sending secrets unless the user explicitly asked for them:

POSIX-shell example (use the equivalent stdin mechanism without command-history exposure in
PowerShell or cmd.exe):

```bash
printf '%s' "$TEXT" | ORCA computer set-value --app <app> --element-index <index> --value-stdin --json
```

## Action Rules

- An action's verification is separate from whether its provider call succeeded:
  - `verified` means the changed value was read back.
  - `unverified (accessibility action unasserted)` means the accessibility call succeeded but no post-state assertion was made.
  - `unverified (suspected noop)` means the accessibility call succeeded but the window's tree and the app's windows were unchanged about a second later. Web and Electron controls often ignore it. Do not repeat the same element click; if the effect you expect would show in the window, retry once with `click --x --y` at the control from a fresh screenshot. If the effect lives elsewhere (clipboard, another app), check there first.
  - `unverified (synthetic input)` means input was fired into the void and is unverifiable.
  - Missing verification metadata is unverified, including responses from older runtimes.
  - Never report an unverified action as success. If it could have sent, submitted, bought, or deleted something, say the effect is unproven.
- Prefer semantic actions: `set-value` for editable fields, `click` for controls, and `perform-secondary-action` only for listed action names.
- After any UI-changing action, use the returned state or rerun `get-app-state` before choosing the next element index.
- Use `type-text` only after focusing a field and confirming the app has a focused text receiver; synthetic keyboard delivery is reported as unverified, so inspect the returned state before assuming text landed.
- Use `press-key` for single/navigation keys such as Return, Escape, Tab, and arrows. Use `hotkey` only for one modifier chord plus one key, such as `CmdOrCtrl+A` or `CmdOrCtrl+Shift+P`; prefer `CmdOrCtrl+...` for cross-platform combos.
- Use `click --modifiers <chord>` for modifier-clicks. Never synthesize separate modifier-down and modifier-up commands around a click; interruption can leave a modifier logically held.
- Coordinates are window-local; use coordinates from the latest screenshot/state for the same target window.

## Background and Foreground Input

On macOS, every action runs in the background by default: the target app is not brought forward, the user's frontmost app and key window stay put, and the real pointer does not move. The user can keep working while you act. `capabilities` reports this as `supports.input.background`, and each action result reports `action.delivery` as `background` or `foreground`.

On Linux and Windows, keyboard and pointer input still need the target window in front; a `window_not_focused` refusal there means retry with `--restore-window`.

Do not pass `--restore-window` by default. Use it only when foreground input is needed, and tell the user first because it takes over their screen, keyboard focus and pointer:

- An action fails with `background_unavailable` that does not name a popup.
- A background action reports success but the UI does not change, and a semantic action (`set-value`, `perform-secondary-action`) cannot do the job.
- Drags in Chromium or Electron apps, and apps that read the hardware pointer (games, OpenGL/Metal views, Java/Tk), which ignore background pointer events.
- The window is minimized or hidden. Accessibility actions still work there; pointer and keyboard events do not.

Popup menus and web `<select>` controls: set the option with `set-value` on the popup element. Background clicks on them are refused because they open the menu off screen or wedge the app's input.

On Linux and Windows, clicks, scrolling, drags and keyboard input still bring the target window forward.

## Screenshots

`get-app-state` and actions request screenshots by default unless `--no-screenshot` is
passed. A successful `--json` capture is normally saved at `result.screenshot.path`; if that
path is absent, use the inline base64 `result.screenshot.data`. Pretty output does not save
images.

Use the tree for indexes/actions and the screenshot for visual confirmation; failed capture usually means hidden, minimized, off-screen, or permission-blocked.

Coordinates passed to `click`, `scroll`, and `drag` are window-local action coordinates. If the screenshot reports `scale` other than `1`, convert visual screenshot pixels before acting:

```text
action_x = screenshot_pixel_x / screenshot.scale
action_y = screenshot_pixel_y / screenshot.scale
```

Prefer element indexes or element frames from the tree when available. Use raw screenshot-derived coordinates only after checking the latest screenshot scale and window size.

On Linux and Windows, screenshots may come from the visible desktop region for the target window bounds. If visual pixels matter, use `--restore-window` so another window does not cover the target region; if you cannot take focus, trust the tree over potentially occluded pixels.

## App Notes

Browsers: for Edge, Chrome, Safari, and similar browser windows, set the address/search field directly, then press Return. Do not assume raw typing went to the address bar. On Linux and Windows, use `--restore-window` when the browser is not already frontmost; on macOS this works in the background. Large tab strips may show only the active tab plus an "inactive browser tabs omitted" marker; treat that as intentional noise reduction and operate on the current page/address bar unless the user asked to manage tabs.

For browser-hosted forms such as Gmail compose, verify the focused UI element after each field action. Page text fields can expose accessibility actions without moving DOM focus; if a click or `set-value` does not change the focused receiver, use `Tab` / `Shift+Tab` from a known focused field or window-local coordinates from a fresh screenshot. Prefer `paste-text` into the verified focused field for draft bodies, then inspect the returned state before continuing.

```text
ORCA computer get-app-state --app com.microsoft.edgemac --json
ORCA computer set-value --app com.microsoft.edgemac --element-index <addressBarIndex> --value "test123" --json
ORCA computer press-key --app com.microsoft.edgemac --key Return --json
```

Spotify: refresh after playback clicks; the UI often changes asynchronously.

Slack: the accessibility tree may be shallow while the screenshot contains useful information. Reading visible Slack UI is fine when requested; sending messages or triggering workflows still needs explicit permission.

## Errors

- `app_not_found`: run `list-apps` and retry with the bundle ID. If the target is a web app such as Gmail, choose the desktop browser app/window that contains it; do not retry `ORCA computer ... --app Gmail` unchanged because `orca computer` app selectors refer to desktop apps, not website names.
- `app_blocked`: stop; the target is intentionally blocked from computer-use.
- `window_not_found` / `window_stale`: run `list-windows`, choose a current selector, then rerun `get-app-state`.
- `background_unavailable`: for a popup or `<select>`, use `set-value` on it; otherwise retry once with `--restore-window` after telling the user it will take over their screen.
- `window_not_focused`: retry once with `--restore-window`; if the message says restore was already requested, stop retrying restore and bring the app forward manually or check permissions. For editable fields prefer `set-value`, then inspect before assuming keyboard input worked.
- `element_not_found`: index is stale; run `get-app-state` again.
- `unsupported_capability`: the provider or desktop environment cannot do that action; use a semantic alternative or install the missing dependency if the message names one.
- `action_not_supported`: inspect the element's listed actions and retry with one of those names, or use click/set-value when appropriate.
- `value_not_settable`: the element cannot accept direct value writes; focus it and use keyboard input only when the returned state can be inspected.
- `element_not_clickable`: the element has no actionable frame; use a parent/child element with a frame or choose window-local coordinates from the latest screenshot.
- `invalid_argument`: fix the command flags; do not retry the same command unchanged.
- `action_timeout`: inspect current state before retrying, then use a simpler semantic action or `--no-screenshot` if observation is slow.
- `verification_failed`: the write was read back and the element holds a different value, so the action failed. Run `get-app-state` to see which field changed. For editable text, click the intended field and confirm focus, select all (`cmd+a` on macOS, `ctrl+a` on Windows/Linux), then use `type-text` and inspect the resulting value instead of repeating `set-value`.
- `screenshot_failed`: use `--no-screenshot` if tree state is enough; if the message names Screen Recording or screenshots permission, run `ORCA computer permissions --id screenshots --json`.
- `accessibility_error`: run `ORCA computer capabilities --json`; if the message names Accessibility permission, run `ORCA computer permissions --id accessibility --json`.
- Empty tree or no screenshot: app may have no visible window, be minimized, or need permissions.
- Permission errors: run `ORCA computer permissions --json`, or `ORCA computer permissions --id accessibility --json` / `--id screenshots --json` when the message names one permission, use the setup UI, then retry.
