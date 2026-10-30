# Built-in browser commands

Pin one page, then use a snapshot-interact-re-snapshot loop on it:

```text
ORCA tab current --json
ORCA goto --page <browserPageId> --url https://example.com --json
ORCA snapshot --page <browserPageId> --json
ORCA click --page <browserPageId> --element @e3 --json
ORCA snapshot --page <browserPageId> --json
```

Common commands:

```text
ORCA goto --page <browserPageId> --url <url> --json
ORCA back --page <browserPageId> --json
ORCA reload --page <browserPageId> --json
ORCA snapshot --page <browserPageId> --json
ORCA screenshot --page <browserPageId> --json
ORCA full-screenshot --page <browserPageId> --json
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
ORCA wait --page <browserPageId> --load networkidle --json
ORCA eval --page <browserPageId> --expression <js> --json
ORCA set device --page <browserPageId> --name "iPhone 15" --json
ORCA viewport --page <browserPageId> --width 390 --height 844 --scale 3 --mobile --json
ORCA tab list --json
ORCA tab create --url <url> --json
ORCA tab switch --index <n> --json
ORCA tab close --index <n> --json
ORCA cookie get --page <browserPageId> --json
ORCA capture start --page <browserPageId> --json
ORCA console --page <browserPageId> --limit 50 --json
ORCA network --page <browserPageId> --limit 50 --json
ORCA exec --page <browserPageId> --command "help" --json
```

Browser rules:

- Re-snapshot after navigation, tab switches, clicks that change the page, and any `browser_stale_ref`.
- Refs like `@e1` are assigned by `snapshot`, scoped to one tab, and invalidated by navigation or tab switch.
- Pass `--page <browserPageId>` on every command that acts on one page; `ORCA <command> --help` lists `--page` when it does. `tab list`, `tab current`, `tab create` and `open-url` take no `--page`, and `tab switch`/`tab close` pick a tab by `--index` or `--page`, never both, since `--page` wins. Take the ID from `result.tab.browserPageId` in `ORCA tab current --json` or `result.browserPageId` in `ORCA tab create --json` and keep it for the task; `tab current` shows the routed tab, not the one you pin. When the user means a specific tab, find it by URL or title in `ORCA tab list --json`.
- Without `--page`, a command goes to the worktree's current tab. That stays the agent's tab while it has had a command in the last 20 seconds or so, even after the user picks another (`tab current` reports it too), then moves to the user's pick.
- After `ORCA tab switch`, pass the new page's `browserPageId`.
- Browser commands default to the current worktree. `--page` reaches the page in any worktree unless you also pass `--worktree <selector>`. Use `--worktree all` only intentionally.
- Use typed tab commands (`ORCA tab list/create/close/switch`), not `ORCA exec --command "tab ..."`, so Orca keeps UI state synchronized.
- Use `ORCA set device` or `ORCA viewport --mobile`, not `ORCA exec --command "set device ..."`, so the page also gets touch input and `pointer: coarse`. Each page load (reload, `goto`, link click) resets it, so run it again after navigating.
- Prefer `wait --text`, `--url`, `--selector`, or `--load` after async page changes instead of bare timeouts.
- Anything not listed above goes through `ORCA exec --page <browserPageId> --command "<agent-browser command>"`.
- `fill` sets a field's whole value in one step, at any size. `type` presses real keys into the focused element, so `minlength`/`maxlength`, key handlers, Enter and Tab act as they would for a person; `ORCA focus` the element first. Use `type` when the page reacts to keystrokes.
- On server-hosted pages `fill` and `type` still insert text the engine's own way. If either does nothing on a custom input there, try `ORCA focus --page <browserPageId> --element @e1 --json` then `ORCA inserttext --page <browserPageId> --text "text" --json`.
- A client-hosted page renders in the paired desktop's browser engine, so every command against it needs that desktop online and returns `browser_host_unavailable` while it is closed, asleep, or disconnected. Server-hosted pages run with no desktop attached; prefer them for long or unattended automation.

Common recoveries:

- `browser_no_tab`: open a tab with `ORCA tab create --url <url> --json`.
- `browser_stale_ref`: run `ORCA snapshot --page <browserPageId> --json` and retry on the same page with fresh refs.
- `browser_element_not_interactable`: the element can't take that command, and the message says why (not a text field, disabled, read-only, not a `<select>`, not a file input). Re-snapshot and pick the right ref; for a custom dropdown, click it and then click the option.
- `browser_tab_not_found`: run `ORCA tab list --json` before switching or closing.
- `browser_host_unavailable`: the desktop hosting the page is offline. Bring it back, or recreate the page with server placement if the work must outlive the desktop session.
