# Built-in browser commands

Pin one page, snapshot it once, then act on it. Each action reports what it changed, so you rarely need to snapshot again:

```text
ORCA tab current --json
ORCA goto --page <browserPageId> --url https://example.com --json
ORCA snapshot --page <browserPageId> --interactive
ORCA click --page <browserPageId> --element @e3 --json
```

Choosing what to look at, cheapest first:

- `snapshot --interactive` lists only controls and links with their refs, often under half the size of the whole tree. It leaves out page text, including error and status messages.
- `--delta` is the cheap second look, for example after a `wait` with no action in between: it returns only what changed since the last `--delta` snapshot of that page, as "no change" or which lines of that tree to replace and with what. Each page keeps one baseline: a navigation, a large change, or a `--delta` call with different flags returns the whole tree again and replaces it. `--full` asks for the whole tree and restarts the baseline.
- `--selector <css>` limits the tree to one part of the page, `--depth <n>` limits nesting, `--compact` drops empty structure, and `--urls` adds link targets.
- To read page text, run `exec --command "read"` (the page as Markdown) or a plain `snapshot` (the whole tree with its text).
- `screenshot` saves a PNG of the visible page and prints its path; open that file to see the page. In Orca's desktop browser its pixels are CSS pixels, so x/y read off it work with `ORCA mouse`. `full-screenshot` saves the whole page the same way. `--annotate` labels each control with its ref, and `--if-changed` saves nothing when the page looks the same as last time.

Common commands:

```text
ORCA goto --page <browserPageId> --url <url> --json
ORCA back --page <browserPageId> --json
ORCA reload --page <browserPageId> --json
ORCA snapshot --page <browserPageId> --interactive
ORCA snapshot --page <browserPageId> --interactive --delta
ORCA snapshot --page <browserPageId> --selector main --depth 4
ORCA screenshot --page <browserPageId>
ORCA screenshot --page <browserPageId> --annotate
ORCA full-screenshot --page <browserPageId>
ORCA pdf --page <browserPageId> --json
ORCA click --page <browserPageId> --element <ref> --json
ORCA fill --page <browserPageId> --element <ref> --value <text> --json
ORCA type --page <browserPageId> --input <text> --json
ORCA select --page <browserPageId> --element <ref> --value <value> --json
ORCA check --page <browserPageId> --element <ref> --json
ORCA scroll --page <browserPageId> --direction down --amount 1000 --json
ORCA hover --page <browserPageId> --element <ref> --json
ORCA focus --page <browserPageId> --element <ref> --json
ORCA keypress --page <browserPageId> --key Enter --json
ORCA upload --page <browserPageId> --element <ref> --files <paths> --json
ORCA wait --page <browserPageId> --text <text> --json
ORCA wait --page <browserPageId> --url <substring> --json
ORCA wait --page <browserPageId> --selector <css> --json
ORCA wait --page <browserPageId> --load load --json
ORCA eval --page <browserPageId> --expression <js> --json
ORCA dialog accept --page <browserPageId> [--text <answer>] --json
ORCA dialog dismiss --page <browserPageId> --json
ORCA set device --page <browserPageId> --name "iPhone 15" --json
ORCA viewport --page <browserPageId> --width 390 --height 844 --scale 3 --mobile --json
ORCA tab list --json
ORCA tab create --url <url> --json
ORCA tab create --url <url> --split right --json
ORCA tab switch --index <n> --json
ORCA tab close --index <n> --json
ORCA cookie get --page <browserPageId> --json
ORCA capture start --page <browserPageId> --json
ORCA console --page <browserPageId> --limit 50 --json
ORCA network --page <browserPageId> --limit 50 --json
ORCA exec --page <browserPageId> --command "read" --json
ORCA exec --page <browserPageId> --command "get text @e3" --json
```

Browser rules:

- Actions (`click`, `fill`, `type`, `keypress`, `select`, `check`, `hover`, `scroll`, `goto`, `back`, `reload`, `mouse` and the rest) wait briefly for the page to settle and then report what they caused in `result.effects` (text mode prints it under the action): `url`/`title` when they changed, `newTabs` with their `browserPageId`, blocked or opened `popups`, `downloads` started, `consoleErrors`, and `page`: `"unchanged"`, or the snapshot lines the action added or replaced, with their refs (`full: true` means the whole new page). `loading: true` means a navigation was still running: `wait --load load`, then `snapshot`. No `page` means the page could not be read: run `snapshot`. `settled: false` means the page was still changing when it was read. An action that opens a JavaScript dialog fails with `browser_dialog_opened` instead.
- Snapshot again only when `page.truncated` is true, after `wait`, after a tab switch, on a `browser_stale_ref`, or when a result has no `effects` (older Orca, or a server-hosted page).
- Refs like `@e1` are assigned by `snapshot`, scoped to one tab, and invalidated by navigation or tab switch.
- Pass `--page <browserPageId>` on every command that acts on one page; `ORCA <command> --help` lists `--page` when it does. `tab list`, `tab current`, `tab create` and `open-url` take no `--page`, and `tab switch`/`tab close` pick a tab by `--index` or `--page`, never both, since `--page` wins. Take the ID from `result.tab.browserPageId` in `ORCA tab current --json` or `result.browserPageId` in `ORCA tab create --json` and keep it for the task; `tab current` shows the routed tab, not the one you pin. When the user means a specific tab, find it by URL or title in `ORCA tab list --json`.
- Without `--page`, a command goes to the worktree's current tab. That stays the agent's tab while it has had a command in the last 20 seconds or so, even after the user picks another (`tab current` reports it too), then moves to the user's pick.
- After `ORCA tab switch`, pass the new page's `browserPageId`.
- A popup window a page opens (sign-in, payment) is listed in `ORCA tab list --json` as a `popup-<n>` page with `openerBrowserPageId`. If a click seems to do nothing, check `tab list`, then drive the popup with `--page popup-<n>`. When it closes, continue on the opener page.
- Browser commands default to the current worktree. `--page` reaches the page in any worktree unless you also pass `--worktree <selector>`. Use `--worktree all` only intentionally.
- `tab list` shows every tab in the tab bar. After a restart, tabs the user has not opened report `loaded: false`; `tab switch` or any `--page` command loads one in the background without changing the user's visible tab.
- `tab create --split <right|left|down|up>` opens the page in a new pane beside the calling terminal instead of as another tab; focus stays in the terminal.
- Use typed tab commands (`ORCA tab list/create/close/switch`), not `ORCA exec --command "tab ..."`, so Orca keeps UI state synchronized.
- Use `ORCA set device` or `ORCA viewport --mobile`, not `ORCA exec --command "set device ..."`, so the page also gets touch input and `pointer: coarse`. Each page load (reload, `goto`, link click) resets it, so run it again after navigating.
- Prefer `wait --text`, `--url`, `--selector`, or `--load` after async page changes instead of bare timeouts. Avoid `--load networkidle` except on pages known to go quiet: polling, websockets and streaming keep it from ever resolving.
- Anything not listed above goes through `ORCA exec --page <browserPageId> --command "<agent-browser command>"`, which takes agent-browser's own command syntax (for example `"get text @e3"` or `"is visible @e3"`) and prints JSON. It has no `help` command.
- `upload` takes the file input itself or the button that opens a file picker, in any frame, including cross-origin iframes; Orca catches the picker and sets the files on its input. Use `ORCA upload`, not `ORCA exec --command "upload ..."`. On server-hosted pages pass the file input's ref.
- `fill` sets a field's whole value in one step, at any size. `type` presses real keys into the focused element, so `minlength`/`maxlength`, key handlers, Enter and Tab act as they would for a person; `ORCA focus` the element first. Use `type` when the page reacts to keystrokes.
- On server-hosted pages `fill` and `type` still insert text the engine's own way. If either does nothing on a custom input there, try `ORCA focus --page <browserPageId> --element @e1 --json` then `ORCA inserttext --page <browserPageId> --text "text" --json`.
- A client-hosted page renders in the paired desktop's browser engine, so every command against it needs that desktop online and returns `browser_host_unavailable` while it is closed, asleep, or disconnected. Server-hosted pages run with no desktop attached; prefer them for long or unattended automation.

Common recoveries:

- `browser_no_tab`: open a tab with `ORCA tab create --url <url> --json`.
- `browser_stale_ref`: run `ORCA snapshot --page <browserPageId> --json` and retry on the same page with fresh refs.
- `browser_element_not_interactable`: the element can't take that command, and the message says why (not a text field, disabled, read-only, not a `<select>`, opened no file picker). Re-snapshot and pick the right ref; for a custom dropdown, click it and then click the option.
- `browser_tab_not_found`: run `ORCA tab list --json` before switching or closing.
- `browser_dialog_open` / `browser_dialog_opened`: the page has a JavaScript alert, confirm or prompt open, and the error quotes it. Answer it with `ORCA dialog accept` (`--text` for a prompt; without it a prompt takes its default) or `ORCA dialog dismiss` before any other command on that page; a command that opened it may already have taken effect, so check before repeating it.
- `browser_host_unavailable`: the desktop hosting the page is offline. Bring it back, or recreate the page with server placement if the work must outlive the desktop session.
