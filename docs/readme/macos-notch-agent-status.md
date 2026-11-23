# macOS agent status at the notch

Enable **Settings → Appearance → Interface → Advanced → Show agent status at the notch** to monitor agents without keeping the main Orca window open. The feature is opt-in and only available in the macOS desktop app.

The compact indicator separates working agents, sessions awaiting input, and unread completions. Click it to expand the session list; click a session to return to its terminal or chat. A completion leaves the list when the existing agent acknowledgement flow marks it read. The panel collapses when the user changes sessions or leaves Orca.

## Display behavior

The indicator uses the primary display. A small Swift helper reads the camera cutout through `NSScreen`; displays without a cutout, or a failed helper read, use a centered capsule. The surface deliberately stays dark next to the black camera housing, including when the application uses a light theme.

The auxiliary window is transparent, non-focusable, and ignores mouse events outside painted content. It follows desktop Spaces but does not opt into fullscreen presentation, which changes Electron's application activation policy. It is excluded from the app-window lookup used for notifications. A macOS N-API addon sets `canHide` and `hidesOnDeactivate` to false on this window only, so minimizing the main window, switching apps, or hiding Orca with Command+H leaves the indicator visible. Quitting Orca or disabling the preference closes it.

## Ownership and lifecycle

Main owns the window geometry, counts, session identities, and snapshots. Local hook and host-owned structured-chat changes come from the existing agent hook server. The feature subscribes independently of the main window, so closing that window does not detach its local status source.

Ready paired hosts publish their session inventories over a passive session-tabs stream. Host-qualified identities keep identical pane keys on different machines separate. Read remote completions persist in desktop UI state as host/pane-qualified transition identities, scoped to the pairing and runtime. Repeated inventories after a restart stay read; a new host transition becomes unread without comparing host and local clocks. The observer does not start disconnected or sleeping hosts. The stream is released when the preference is disabled or the application quits.

The renderer only presents snapshots and requests actions by current row identity; main resolves the target from its own inventory. IPC actions validate both the sender frame and the owning window. Existing workspace and structured-chat activation paths perform navigation. Reading a session uses the existing acknowledgement flow rather than assuming that a click succeeded.

Quit tears down the auxiliary window before it can prevent `window-all-closed`; an aborted main-window close recreates it. An updater that already prevented quit leaves the indicator intact. Background launches keep the auxiliary window hidden, following the same `ORCA_BACKGROUND_LAUNCH=1` policy as other Orca windows.

## Validation

Use `ORCA_BACKGROUND_LAUNCH=1 pnpm dev` in a separate worktree, read `out/dev-instance.json`, and attach Playwright with `chromium.connectOverCDP(cdpUrl)`. Keep windows hidden. Check the native renderer's reported size before capturing it; do not activate the window to obtain a screenshot.

- Toggle the preference and verify creation/destruction of the auxiliary CDP target.
- Drive working, waiting, and completed transitions through an authenticated hook or a real agent session.
- Expand the list, navigate to a terminal and a structured chat, and verify acknowledgements after viewing.
- On an isolated display, hide Orca with Command+H and verify that only the notch remains visible; disable the preference while hidden and verify it closes.
- Close and reopen the main window, reload its renderer, and verify that navigation still reaches the session.
- Disable the preference while a repaint or remote connection is pending; it must not revive the closed panel.
- On an available paired host, verify live updates and disconnection without waking a stopped host.

Presentational states are available with `ORCA_BACKGROUND_LAUNCH=1 pnpm fixtures:shot notch/NotchPanel --theme both`. These fixtures use illustrative sessions and show the intentionally dark indicator against light and dark surroundings. Native focus, physical menu-bar hit testing, fullscreen behavior, and other desktop platforms require an isolated display or CI.

The implementation continues the work by Tomas Oliver (@tomi204) in [PR #11795](https://github.com/stablyai/orca/pull/11795), tracked by [issue #31521](https://github.com/stablyai/orca/issues/31521). iPhone Live Activities remain a separate feature in [issue #8127](https://github.com/stablyai/orca/issues/8127).
