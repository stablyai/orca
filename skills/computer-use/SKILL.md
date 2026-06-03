---
name: computer-use
description: >-
  Use Orca's computer-use CLI to inspect and operate local desktop app windows
  through accessibility trees, screenshots, and safe UI actions. Use for
  desktop app interaction: list apps/windows, get app state, read visible UI,
  click controls, type, press keys, scroll, drag, set values, or perform
  accessibility actions. Also use for browser windows, webviews, Orca app UI,
  or any desktop UI outside Orca's built-in browser. Triggers include "computer
  use", "orca computer", "read Spotify", "read Slack", "control/click/read in
  a desktop app", and "get app state".
---

# Computer Use

Use this skill for desktop UI through Orca's computer-use surface.

Routing:

- Use Orca built-in browser commands (`orca snapshot`, `orca click`, `orca fill`, etc.) only for the browser page embedded inside the Orca app.
- Use `orca computer` for native desktop apps, external browser windows, app/webview chrome, Orca settings/app UI, and any desktop UI outside Orca's embedded browser.

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

Use the fresh state returned by each action for the next element index. Element indexes go stale after navigation, focus changes, scrolling, window changes, or app re-rendering.

## App Selectors

Prefer bundle IDs from `list-apps`; names are acceptable when unambiguous. Use `pid:<number>` only when bundle ID or name matching is ambiguous.

```bash
orca computer get-app-state --app com.microsoft.edgemac --json
orca computer get-app-state --app Spotify --json
orca computer get-app-state --app pid:12345 --json
```

For apps with multiple windows or ambiguous titles, run `list-windows` first. Once you choose a window, pass the same `--window-id <id>` or `--window-index <n>` to `get-app-state` and later actions until the target window changes.

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
- Use `type-text` only after focusing a field and confirming the app has a focused text receiver.
- Use `press-key` for single/navigation keys such as Return, Escape, Tab, and arrows. Use `hotkey` for shortcuts; prefer `CmdOrCtrl+...` for cross-platform combos.
- Some actions work in background apps, but this is app-dependent. If success does not change the UI, refresh state and choose a more semantic action or restore/focus the window.
- Coordinates are window-local; use coordinates from the latest screenshot/state for the same target window.

## Screenshots

`get-app-state` returns tree+screenshot. Use the tree for indexes/actions and the screenshot for visual confirmation; failed capture usually means hidden, minimized, off-screen, or permission-blocked.

## App Notes

Browsers: for Edge, Chrome, and similar browser windows, set the address/search field directly, then press Return. Do not assume raw typing went to the address bar.

```bash
orca computer get-app-state --app com.microsoft.edgemac --json
orca computer set-value --app com.microsoft.edgemac --element-index <addressBarIndex> --value "test123" --json
orca computer press-key --app com.microsoft.edgemac --key Return --json
```

Spotify: refresh after playback clicks; the UI often changes asynchronously.

Slack: the accessibility tree may be shallow while the screenshot contains useful information. Reading visible Slack UI is fine when requested; sending messages or triggering workflows still needs explicit permission.

## Errors

- `app_not_found`: run `list-apps` and retry with the bundle ID.
- `element_not_found`: index is stale; run `get-app-state` again.
- `action_failed`: inspect the element role/actions and try a more semantic action.
- Empty tree or no screenshot: app may have no visible window, be minimized, or need permissions.
- Permission errors: run `orca computer permissions --json`, use the setup UI, then retry.

## Next Action

Confirm Orca status unless already checked, run `orca computer capabilities --json`, then get the target app state with `orca computer get-app-state --app <app> --json`.
