---
name: orca-computer-use
description: >-
  Drives the GUI of a local app window in the background through `orca computer`,
  without bringing it forward or taking the user's keyboard and pointer where the
  platform allows: accessibility tree, clicks, typing, menus, dialogs, and screenshots
  in native apps and external browser windows (Chrome, Edge, Safari) or webviews.
  Prefer a programmatic path (shell, filesystem, git, HTTP, existing CLIs) whenever
  it can complete the task. Use only when an app window needs GUI control those
  cannot reach. Do not use for Orca's embedded browser (`orca-cli`).
---

# Orca Computer Use

Use this skill to drive an app window through `orca computer`, in the background where the platform allows, so the user can keep working. Prefer a programmatic path (shell, filesystem, git, HTTP, existing CLIs) whenever it can complete the task; use this skill only when an app window needs GUI control those cannot reach. Do not use it for Orca's embedded browser (`orca-cli`).

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

A snapshot reads at most `truncation.maxNodes` elements and `maxDepth` levels. When it stops early, `truncation.truncated` is true and each cut-off place shows a `... N more not shown (snapshot limit)` line, indented like the children it stands for. To read them, pass the parent element's index (the nearest line above with less indentation) as `get-app-state --element-index <n>`: it reads only that element and its descendants, with the full limit. Elements already shown keep their indexes and hidden ones get new ones, and you can act on them. Action results show the whole window again, so read the subtree again before acting on another hidden element.

```text
ORCA computer get-app-state --app com.apple.Safari --element-index 312 --json
```

## Waiting

Never `sleep` between actions. When the UI changes on its own after an action (a save finishes, a dialog opens, a button becomes clickable), wait for the change with `wait`. It returns as soon as the condition holds and prints the matching elements or windows; it fails with `wait_timeout` if the condition does not hold in time (default 10 s, `--timeout <ms>` up to 120000).

```text
ORCA computer wait --app <app> --text "Saved" --json
ORCA computer wait --app <app> --enabled "Continue" --json
ORCA computer wait --app <app> --window-title "Save As" --json
```

- `--text <text>`: an element line contains the text (case-insensitive, like `--query`).
- `--enabled <text>`: an element contains the text and none of the elements containing it is disabled. Use text only the intended control shows; a label that repeats the button text also has to be enabled.
- `--window-title <text>`: one of the app's windows has the text in its title, as `list-windows` reports them. Then target that window with its `--window-id` or `--window-index`. On Windows, `list-windows` reports only the app's main window, so wait for a dialog with `--text` instead.

`wait` only reads the app; it never acts, raises or restores a window. The app or window may be missing at first; `wait` keeps checking until it appears. Element indexes in the output come from a fresh tree, so you can act on them next.

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
ORCA computer wait --app <app> (--text <text> | --enabled <text> | --window-title <text>) [--timeout <ms>] --json
ORCA computer click --app <app> --element-index <index> --json
ORCA computer click --app <app> --x 100 --y 100 --json
ORCA computer click --app <app> --x 100 --y 100 --modifiers CmdOrCtrl+Shift --json
ORCA computer click --app <app> --element-index <index> --mouse-button right --json
ORCA computer click --app <app> --element-index <index> --mouse-button middle --json
ORCA computer perform-secondary-action --app <app> --element-index <index> --action <name> --json
ORCA computer set-value --app <app> --element-index <index> --value "text" --json
ORCA computer type-text --app <app> --text "text" --json
ORCA computer type-text --app <app> --element-index <index> --text "text" --json
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
  - `unverified (text mismatch)` means typed or pasted text was read back and the focused field does not hold what inserting it should produce: it may be missing, partly entered, reformatted or autocompleted, or taken by a control that does not store it (terminals and canvas editors leave their input field empty). Do not type it again blindly, or it may land twice; check a fresh screenshot or `get-app-state` first.
  - Missing verification metadata is unverified, including responses from older runtimes.
  - Never report an unverified action as success. If it could have sent, submitted, bought, or deleted something, say the effect is unproven.
- Prefer semantic actions: `set-value` for editable fields, `click` for controls, and `perform-secondary-action` only for listed action names.
- After any UI-changing action, use the returned state or rerun `get-app-state` before choosing the next element index.
- Use `type-text` only after focusing a field and confirming the app has a focused text receiver; unless the result says `verified focusedText`, inspect the returned state before assuming text landed.
- `type-text --element-index <index>` inserts at that text field's caret, replacing its selection, without focusing it or bringing its window forward, and reads the text back. It works on macOS and Linux; where `capabilities` lacks `actions.typeTextElement` it fails with `unsupported_capability`; then click the field, confirm it is the focused text receiver, and type without the index. A `value_not_settable` error means that element does not accept text insertion.
- Use `press-key` for single/navigation keys such as Return, Escape, Tab, and arrows. Use `hotkey` only for one modifier chord plus one key, such as `CmdOrCtrl+A` or `CmdOrCtrl+Shift+P`; prefer `CmdOrCtrl+...` for cross-platform combos.
- Shortcuts that quit or close the app, log out, lock the screen, force-quit or end the session (such as `Cmd+Q` on macOS, `Alt+F4` on Windows and Linux, `Ctrl+Q` on Linux) are refused with `system_shortcut_blocked`. The error says what the shortcut would do; reach that goal another way, such as the window's own close button or menu item. Add `--allow-system-shortcut` only when the user asked for that exact shortcut.
- Use `click --modifiers <chord>` for modifier-clicks. Never synthesize separate modifier-down and modifier-up commands around a click; interruption can leave a modifier logically held.
- Coordinates are window-local; use coordinates from the latest screenshot/state for the same target window.

## Background and Foreground Input

Actions run in the background wherever the platform can, so the user keeps their screen, keyboard focus and pointer while you act. Each action result reports `action.delivery`: `background` means the user's foreground window stayed put, `foreground` means the target came forward.

**Never add `--restore-window` on your own.** It brings the target app forward and takes over the user's screen, keyboard focus and pointer. Do not add it to recover from an error, even when an error message or next step mentions it, and do not add it just to observe a window. When only foreground input can do the job, stop, tell the user which action needs the foreground and why, and pass `--restore-window` only after they agree. If an error says restore was already requested, do not retry it; ask the user.

These need the foreground, so ask the user first:

- An action fails with `background_unavailable` and no semantic action (`set-value`, `perform-secondary-action`, `type-text --element-index`) can do the job.
- A background action reports success but the UI does not change, and no semantic action can do the job.
- On macOS, drags in Chromium or Electron apps, and apps that read the hardware pointer (games, OpenGL/Metal views, Java/Tk), which ignore background pointer events.
- On Windows, keyboard input (`press-key`, `hotkey`, `paste-text` and `type-text`) needs the target window focused; otherwise it is refused with `window_not_focused` and nothing is sent. For editable fields use `set-value`.
- On Linux and Windows, actions that need the real pointer, and on Linux keys sent while the target window is not active (Return in a focused GTK text field works). They are refused with `background_unavailable`; see below.

On macOS, `list-windows` and `get-app-state` also read windows that are minimized, hidden (Cmd+H) or on another Space, full-screen ones included; `isMinimized` and `isOffscreen` say which. Element actions work there (`click --element-index`, `set-value`, `type-text --element-index`, secondary actions), while coordinate clicks, scrolls, drags, keys and pastes are refused with `background_unavailable` and nothing is sent. Minimized and hidden windows have no screenshot. A window on another Space that nothing has read yet fails with `window_not_found`; ask the user to show it once.

On macOS, background actions that would open a menu or dialog over the user are refused before anything is sent: right-clicks and Control-clicks, clicks or drags that start on popup menus, menu buttons, native combo boxes and web `<select>` controls, and buttons whose title ends in an ellipsis (`Save…`), which usually open a dialog. For a popup, native combo box or `<select>`, set the option with `set-value` on that element.

On macOS, every action without `--restore-window` runs in the background: the target app is not brought forward, the user's frontmost app and key window stay put, and the real pointer does not move. `capabilities` reports this as `supports.input.background`.

On Linux, element clicks through the element's accessibility action (or, for a list row with none, its list's selection), `set-value`, `type-text --element-index` and secondary actions run without raising the window or moving the pointer, and Return in a focused GTK text field runs its activate action. Scrolling moves the nearest scroll bar under the element or point by whole viewports, or pages a web document, also in the background. Anything that needs the real pointer (other clicks with no accessibility action, right, middle, multiple or modified clicks, scrolls in a view with no scroll bar or document, drags) or the focused window (other keys, typing with no focused editable field) is refused with `background_unavailable` and nothing is sent; so is a click that would open a menu, a keyboard-grabbing popup or a dialog (a GTK 4 or Qt label ending in `…`). Ask the user before retrying with `--restore-window`, which raises only the target window, refuses a window on another workspace and puts the cursor back. On Wayland, synthetic pointer and key input never reaches native windows, so it is refused even with the flag. `action.delivery` is measured: `foreground` when the input went to the window in front or the target came forward.

On Windows, these actions go through UI Automation when the control supports them, without moving the pointer or sending keys: element clicks, `set-value` (including sliders), scrolls of an element or of the scrollable area under `--x`/`--y` (fractional `--pages` too), and secondary actions such as `Invoke`, `Toggle`, `Select`, `Expand`, `Collapse` and `ScrollToVisible` (the last brings a list or tree item into view). Some apps bring their own window forward when driven this way (WPF apps do for most of these), so read `action.delivery`: `background` means the user's foreground window stayed put, `foreground` means the target came forward. Clicks by coordinates, right, middle, modified and multi-clicks, clicks on elements with no `Invoke`, `Select` or `Toggle` action, scrolls over nothing scrollable, and drags need the real mouse, so they are refused with `background_unavailable` and nothing is sent. With `--restore-window` (after asking the user), only the target window comes forward, never one on another virtual desktop, and the pointer goes back where it was.

## Starting Apps

`orca computer` does not launch apps. On macOS, start one without bringing it forward with `open -g -a <App>` (or `open -g -b <bundle-id>`); plain `open -a` brings it to the front. Some apps, such as many Electron apps, still bring their own window forward when it opens. On Windows and Linux a newly started app usually comes to the front, so ask the user before starting one.

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

On Linux, screenshots on X11, Hyprland and Sway copy the screen region under the target window, so a window covering it shows in the image; KDE returns a screenshot error instead. On Windows, screenshots come from the window itself even when it is covered, unless the window renders blank that way; then they fall back to the screen region, which can show what covers it. Trust the tree over pixels that may be covered; never add `--restore-window` just to get clean pixels.

## App Notes

Browsers: for Edge, Chrome, Safari, and similar browser windows, set the address/search field directly, then press Return. Do not assume raw typing went to the address bar. On Linux and Windows, pressing Return needs the browser window focused (see Background and Foreground Input); on macOS it works in the background. Large tab strips may show only the active tab plus an "inactive browser tabs omitted" marker; treat that as intentional noise reduction and operate on the current page/address bar unless the user asked to manage tabs.

For browser-hosted forms such as Gmail compose, verify the focused UI element after each field action. Page text fields can expose accessibility actions without moving DOM focus; if a click or `set-value` does not change the focused receiver, use `Tab` / `Shift+Tab` from a known focused field or window-local coordinates from a fresh screenshot. Prefer `paste-text` into the verified focused field for draft bodies, then inspect the returned state before continuing.

```text
ORCA computer get-app-state --app com.microsoft.edgemac --json
ORCA computer set-value --app com.microsoft.edgemac --element-index <addressBarIndex> --value "test123" --json
ORCA computer press-key --app com.microsoft.edgemac --key Return --json
```

Spotify: the UI often changes asynchronously after playback clicks; `wait --text` for the change instead of re-reading in a loop.

Slack: the accessibility tree may be shallow while the screenshot contains useful information. Reading visible Slack UI is fine when requested; sending messages or triggering workflows still needs explicit permission.

## Errors

- `app_not_found`: run `list-apps` and retry with the bundle ID. If the target is a web app such as Gmail, choose the desktop browser app/window that contains it; do not retry `ORCA computer ... --app Gmail` unchanged because `orca computer` app selectors refer to desktop apps, not website names.
- `app_blocked`: stop; the target is intentionally blocked from computer-use.
- `system_shortcut_blocked`: the error message says what the shortcut would do. Reach the same goal with a semantic action, such as a button or menu item, or ask the user; retry with `--allow-system-shortcut` only when the user asked for that exact shortcut.
- `window_not_found` / `window_stale`: run `list-windows`, choose a current selector, then rerun `get-app-state`. If the app has no usable window, ask the user to open or show one; do not add `--restore-window` to observe it.
- `background_unavailable`: nothing was sent. For a popup or `<select>`, use `set-value` on it. Otherwise use a semantic action if one fits; if only foreground input can do it, tell the user and ask before retrying with `--restore-window`.
- `window_not_focused`: unless the message says input may already have been delivered (then inspect state first), nothing was sent. For editable fields use `set-value` or `type-text --element-index`; otherwise ask the user before retrying with `--restore-window`. If the message says restore was already requested, do not retry it; ask the user to bring the window forward or check permissions.
- `element_not_found`: index is stale; run `get-app-state` again.
- `unsupported_capability`: the provider or desktop environment cannot do that action; use a semantic alternative or install the missing dependency if the message names one.
- `action_not_supported`: inspect the element's listed actions and retry with one of those names, or use click/set-value when appropriate.
- `value_not_settable`: the element cannot accept direct value writes; focus it and use keyboard input only when the returned state can be inspected.
- `element_not_clickable`: no click was sent. If the message says the element is covered, deal with what covers it (a dialog, sheet or popover), then click again from a fresh `get-app-state`; never click by coordinates to get past the cover. If it is out of view, scroll its container first. Otherwise the element has no actionable frame; use a parent/child element with a frame or choose window-local coordinates from the latest screenshot.
- `element_not_enabled`: the element is disabled (its line lists `disabled`), so nothing was sent. Do what enables it first, then act once a fresh `get-app-state` no longer lists it as disabled.
- `invalid_argument`: fix the command flags; do not retry the same command unchanged.
- `action_timeout`: inspect current state before retrying, then use a simpler semantic action or `--no-screenshot` if observation is slow.
- `wait_timeout`: the condition did not hold in time. Run `get-app-state` to see what the app shows; wait again with a longer `--timeout` only if it is still working, otherwise match text the tree actually shows.
- `verification_failed`: the write was read back and the element holds a different value, so the action failed. Run `get-app-state` to see which field changed. For editable text, click the intended field and confirm focus, select all (`cmd+a` on macOS, `ctrl+a` on Windows/Linux), then use `type-text` and inspect the resulting value instead of repeating `set-value`.
- `screenshot_failed`: use `--no-screenshot` if tree state is enough; if the message names Screen Recording or screenshots permission, run `ORCA computer permissions --id screenshots --json`.
- `accessibility_error`: run `ORCA computer capabilities --json`; if the message names Accessibility permission, run `ORCA computer permissions --id accessibility --json`.
- Empty tree or no screenshot: app may have no visible window, be minimized, or need permissions.
- Permission errors: run `ORCA computer permissions --json`, or `ORCA computer permissions --id accessibility --json` / `--id screenshots --json` when the message names one permission, use the setup UI, then retry.
