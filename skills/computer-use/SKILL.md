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

Use this skill for desktop UI through `orca computer`. When the requested target is a website or web app, operate the desktop browser app/window that contains the page.

## Preconditions

- Prefer `orca computer ...`; on Linux, use `orca-ide computer ...` if `orca` is unavailable. In this Orca worktree, use `./config/scripts/orca-dev computer ...` only when testing the local dev runtime.
- Prefer `--json`. Screenshot bytes are omitted from JSON and written to `screenshot.path`.
- Do not push, submit forms, send messages, buy items, delete data, change account settings, or expose secrets unless the user explicitly asked for that action.
- If an app contains sensitive content, read only what the user requested.

```bash
orca status --json
orca computer capabilities --json
```

## Core Loop

```bash
orca computer list-apps --json
orca computer get-app-state --app com.spotify.client --json
orca computer click --app com.spotify.client --element-index 42 --json
```

Use the fresh state returned by each action for the next element index. Element indexes are the numeric labels shown in the tree; they may be sparse when noisy sections are omitted, so never infer valid indexes from `elementCount` or "Visible elements." Element indexes are short-lived and go stale after delays, navigation, focus changes, scrolling, window changes, or app re-rendering.

## App Selectors

Prefer bundle IDs from `list-apps`; names are acceptable when unambiguous. Use `pid:<number>` only when bundle ID or name matching is ambiguous.

```bash
orca computer get-app-state --app com.microsoft.edgemac --json
orca computer get-app-state --app Spotify --json
orca computer get-app-state --app pid:12345 --json
```

For apps with multiple windows or ambiguous titles, run `list-windows` first. Prefer `--window-id <id>` when the listed id is not `none`; otherwise use `--window-index <n>`. Once you choose a window, pass the same selector to `get-app-state` and later actions until the target window changes.

## Commands

```bash
orca computer permissions --json
orca computer capabilities --json
orca computer list-apps --json
orca computer list-windows --app <app> --json
orca computer get-app-state --app <app> --json
orca computer get-app-state --app <app> --restore-window --json
orca computer click --app <app> --element-index <index> --json
orca computer click --app <app> --x 100 --y 100 --json
orca computer perform-secondary-action --app <app> --element-index <index> --action <name> --json
orca computer set-value --app <app> --element-index <index> --value "text" --json
orca computer type-text --app <app> --text "text" --json
orca computer press-key --app <app> --key Return --json
orca computer hotkey --app <app> --key CmdOrCtrl+A --json
orca computer paste-text --app <app> --text "text" --json
orca computer scroll --app <app> (--element-index <index> | --x <x> --y <y>) --direction down --json
orca computer drag --app <app> --from-element-index <index> --to-element-index <index> --json
orca computer drag --app <app> --from-x 100 --from-y 100 --to-x 300 --to-y 300 --json
```

Use `--no-screenshot` only when pixels are not needed. Use `--text-stdin` or `--value-stdin` for sensitive text so payloads do not land in shell history. On Linux and Windows, action payloads still pass through a short-lived local operation file, so avoid sending secrets unless the user explicitly asked for them:

```bash
printf '%s' "$TEXT" | orca computer set-value --app <app> --element-index <index> --value-stdin --json
```

## Action Rules

- Prefer semantic actions: `set-value` for editable fields, `click` for controls, `perform-secondary-action` only for listed action names.
- After any UI-changing action, use the returned state or rerun `get-app-state` before choosing the next element index.
- Use `type-text` only after focusing a field and confirming the app has a focused text receiver; synthetic keyboard delivery is reported as unverified, so inspect the returned state before assuming text landed.
- Use `press-key` for single/navigation keys such as Return, Escape, Tab, and arrows. Use `hotkey` only for one modifier chord plus one key, such as `CmdOrCtrl+A` or `CmdOrCtrl+Shift+P`; prefer `CmdOrCtrl+...` for cross-platform combos.
- Some actions work in background apps, but this is app-dependent. If success does not change the UI, refresh state and choose a more semantic action or restore/focus the window.
- Prefer `set-value` for text fields that expose values; it can report verified value writes when the provider can read the refreshed value.
- Coordinates are window-local; use coordinates from the latest screenshot/state for the same target window.

## Screenshots

`get-app-state` returns tree+screenshot. Use the tree for indexes/actions and the screenshot for visual confirmation; failed capture usually means hidden, minimized, off-screen, or permission-blocked.

Coordinates passed to `click`, `scroll`, and `drag` are window-local action coordinates. If the screenshot reports `scale` other than `1`, convert visual screenshot pixels before acting:

```text
action_x = screenshot_pixel_x / screenshot.scale
action_y = screenshot_pixel_y / screenshot.scale
```

Prefer element indexes or element frames from the tree when available. Use raw screenshot-derived coordinates only after checking the latest screenshot scale and window size.

On Linux and Windows, screenshots may come from the visible desktop region for the target window bounds. If visual pixels matter, use `--restore-window` so another window does not cover the target region; if you cannot take focus, trust the tree over potentially occluded pixels.

## App Notes

Browsers: for Edge, Chrome, Safari, and similar browser windows, set the address/search field directly, then press Return. Do not assume raw typing went to the address bar. Use `--restore-window` when the browser is not already frontmost. Large tab strips may show only the active tab plus an "inactive browser tabs omitted" marker; treat that as intentional noise reduction and operate on the current page/address bar unless the user asked to manage tabs.

For browser-hosted forms such as Gmail compose, verify the focused UI element after each field action. Page text fields can expose accessibility actions without moving DOM focus; if a click or `set-value` does not change the focused receiver, use `Tab` / `Shift+Tab` from a known focused field or window-local coordinates from a fresh screenshot. Prefer `paste-text` into the verified focused field for draft bodies, then inspect the returned state before continuing.

```bash
orca computer get-app-state --app com.microsoft.edgemac --restore-window --json
orca computer set-value --app com.microsoft.edgemac --element-index <addressBarIndex> --value "test123" --json
orca computer press-key --app com.microsoft.edgemac --key Return --json
```

Spotify: refresh after playback clicks; the UI often changes asynchronously.

Slack: the accessibility tree may be shallow while the screenshot contains useful information. Reading visible Slack UI is fine when requested; sending messages or triggering workflows still needs explicit permission.

## Errors

- `app_not_found`: run `list-apps` and retry with the bundle ID. If the target is a web app such as Gmail, choose the desktop browser app/window that contains it; do not retry `orca computer ... --app Gmail` unchanged because `orca computer` app selectors refer to desktop apps, not website names.
- `app_blocked`: stop; the target is intentionally blocked from computer-use.
- `window_not_found` / `window_stale`: run `list-windows`, choose a current selector, then rerun `get-app-state`.
- `window_not_focused`: retry once with `--restore-window`; if the message says restore was already requested, stop retrying restore and bring the app forward manually or check permissions. For editable fields prefer `set-value`, then inspect before assuming keyboard input worked.
- `element_not_found`: index is stale; run `get-app-state` again.
- `unsupported_capability`: the provider or desktop environment cannot do that action; use a semantic alternative or install the missing dependency if the message names one.
- `action_not_supported`: inspect the element's listed actions and retry with one of those names, or use click/set-value when appropriate.
- `value_not_settable`: the element cannot accept direct value writes; focus it and use keyboard input only when the returned state can be inspected.
- `element_not_clickable`: the element has no actionable frame; use a parent/child element with a frame or choose window-local coordinates from the latest screenshot.
- `invalid_argument`: fix the command flags; do not retry the same command unchanged.
- `action_timeout`: inspect current state before retrying, then use a simpler semantic action or `--no-screenshot` if observation is slow.
- `screenshot_failed`: use `--no-screenshot` if tree state is enough; if the message names Screen Recording or screenshots permission, run `orca computer permissions --id screenshots --json`.
- `accessibility_error`: run `orca computer capabilities --json`; if the message names Accessibility permission, run `orca computer permissions --id accessibility --json`.
- Empty tree or no screenshot: app may have no visible window, be minimized, or need permissions.
- Permission errors: run `orca computer permissions --json`, or `orca computer permissions --id accessibility --json` / `--id screenshots --json` when the message names one permission, use the setup UI, then retry.

## Next Action

Confirm Orca status unless already checked, then run `orca computer capabilities --json`. For website or web-app targets such as Gmail, identify the desktop browser app/window that contains the page, then get that target app state with `orca computer get-app-state --app <app> --json`.
