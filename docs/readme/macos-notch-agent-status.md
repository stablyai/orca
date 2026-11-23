# macOS agent status at the notch

The macOS desktop app shows agent status at the notch by default, without keeping the main Orca window open. Disable or re-enable it at **Settings → Appearance → Interface → Advanced → Show agent status at the notch**. A missing preference enables the indicator; a saved `false` remains disabled.

The compact indicator separates working agents, sessions awaiting input, and unread completions. Hover over the indicator to expand the session list. Clicking the bar toggles the list; clicking a session returns to its terminal or chat. Leaving the indicator/list closes it after a short pointer-transition grace period. A completion leaves the list when the existing agent acknowledgement flow marks it read. Sessions already visible in the foreground Orca window are omitted from the indicator, including visible split panes and structured chats. Hidden tabs and workspaces remain listed. Switching apps, minimizing, or hiding Orca with Command+H brings those sessions back; this temporary suppression does not mark a completion read. The panel collapses when the user changes sessions or leaves Orca.

## Display behavior

The indicator hides completely when there are no sessions to display and reappears when a session becomes eligible. The renderer stays subscribed while hidden; no idle glyph is shown.

The indicator uses the primary display. Both wings have equal width around the physical camera cutout, and the panel keeps the same horizontal bounds when it expands. A small Swift helper reads the camera cutout through `NSScreen`; displays without a cutout, or a failed helper read, use a centered capsule. If native geometry is unavailable, the capsule sits below the potential camera cutout instead of inside it. The surface deliberately stays dark next to the black camera housing, including when the application uses a light theme.

The auxiliary window is transparent, non-focusable, and ignores mouse events outside painted content. It follows desktop Spaces but does not opt into fullscreen presentation, which changes Electron's application activation policy. It is excluded from the app-window lookup used for notifications. A macOS N-API addon sets `canHide` and `hidesOnDeactivate` to false on this window only, so minimizing the main window, switching apps, or hiding Orca with Command+H leaves the indicator visible. Quitting Orca or disabling the preference closes it. On macOS 27+, the addon also guards a window-scoped private AppKit activation-prevention selector to work around [Electron #53889](https://github.com/electron/electron/issues/53889): pressing the bar must not activate Orca. The selector is checked for availability and signature before use; unsupported systems log a warning. Remove this workaround once the bundled Electron fixes the upstream bug.

## Ownership and lifecycle

Main owns the window geometry, counts, session identities, and snapshots. Local hook and host-owned structured-chat changes come from the existing agent hook server. The feature subscribes independently of the main window, so closing that window does not detach its local status source.

Ready paired hosts publish their session inventories over a passive session-tabs stream. Host-qualified identities keep identical pane keys on different machines separate. Read completions persist in desktop UI state by pane and observed transition identity; remote identities are additionally scoped to their host, pairing, and runtime. Only a read matching the current completion updates this record, so a delayed read cannot consume a newer completion. The notch does not import generic UI read timestamps for this decision. Repeated inventories after a restart stay read; a new host transition becomes unread without comparing host and local clocks. The observer does not start disconnected or sleeping hosts. The stream is released when the preference is disabled or the application quits.

Session rows use the same conversation-name resolver as the sidebar, including custom names, provider session titles, and split-pane titles. A prompt or workspace name is used only when the session has no name. Title changes refresh the indicator through existing session subscriptions.

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
