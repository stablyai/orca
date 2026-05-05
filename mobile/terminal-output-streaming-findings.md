# Mobile Terminal Output Streaming Findings

Date: 2026-04-28

## Scope

The investigation was limited to `mobile/`. Server-side files under `src/main/` were read for context only and were not modified.

## Verified Findings

- The phone can connect to `ws://192.168.0.179:6768`, list worktrees, list terminals, and call `terminal.send`.
- The phone's saved host token is valid; a direct WebSocket probe from the desktop using the same token can call `worktree.ps`, `terminal.list`, `terminal.subscribe`, `terminal.send`, and `terminal.read`.
- `TerminalWebView` can render text when the React Native side writes to it after xterm initializes. A temporary marker written after `init()` appeared visibly in the WebView.
- Messages posted to the WebView before its page installs message handlers can be dropped. The mobile fix queues `init`, `write`, and `clear` until the WebView reports `web-ready`.
- The WebView also has an internal queue for writes that arrive after `web-ready` but before xterm finishes `init()`.
- The selected physical-phone test worktree was `refs/heads/tasks-improvements` at `/Users/jinwoohong/orca/workspaces/orca/pr-1172-review`.
- For that test worktree, `terminal.subscribe` produced an initial `scrollback` event with an empty `lines` array and no serialized buffer.
- Sending commands to that test terminal returned `ok:true`, but a direct WebSocket `terminal.read` for the same handle still returned an empty tail and no live `data` chunks were observed.
- Creating a fresh terminal with `terminal.create` in that same worktree also returned a writable handle, but `terminal.send` followed by delayed `terminal.read` still returned an empty tail.
- Adding a mobile-side `terminal.read` fallback did not make the current physical-phone test terminal display output, because the direct WebSocket `terminal.read` response for `mobile-output-test` remained `tail: []` and `lastOutputAt: null` after `echo hi`.
- Calling `terminal.show` before `terminal.send` on `mobile-output-test` returned a connected/writable terminal with a `ptyId`, but a delayed `terminal.read` still returned an empty tail.
- Root cause found after building a no-phone repro: daemon-backed PTYs were forwarding provider data to the desktop renderer, but not into `runtime.onPtyData`. The runtime tail buffer and `terminal.subscribe` listeners are fed by `runtime.onPtyData`, so the phone saw accepted sends with no output.
- Fix: `src/main/ipc/pty.ts` now forwards `provider.onData` into `runtime.onPtyData` for non-`LocalPtyProvider` providers. Local PTYs already use the LocalPtyProvider configure hook, so the guard avoids duplicate local output.
- After restarting Electron, `pnpm exec tsx mobile/scripts/test-subscribe.ts <deviceToken>` passed: both `streamSawMarker` and `readSawMarker` were `true`.
- After the backend fix, the physical phone rendered the repro marker in `TerminalWebView`.
- Because of the empty tail/no live stream on that specific desktop terminal, the physical `ls` test did not prove the WebView display path after real PTY output.

## Changes Made

- `mobile/src/terminal/TerminalWebView.tsx`
  - Added a native-side queue so WebView messages are not sent until the HTML reports `web-ready`.
  - Added a WebView-side queue so writes wait until xterm finishes `init()`.
- `mobile/src/transport/rpc-client.ts`
  - Stored full stream request metadata so active streams can be replayed after reconnect.
  - Avoided sending a subscription before the socket reaches `connected`.
  - Fixed `terminal.unsubscribe` to use the terminal handle as `subscriptionId`, matching runtime cleanup behavior.
- `mobile/app/h/[hostId]/session/[worktreeId].tsx`
  - Clears and resubscribes when the worktree changes.
  - Tracks the active terminal handle in a ref so stale handles are replaced when `terminal.list` changes.
  - Routes scrollback and live data into `TerminalWebView`.

## Useful Commands

```bash
agent-device devices --json
agent-device snapshot --platform android --serial R3CX105QXRH --json
agent-device fill @e33 "ls" --platform android --serial R3CX105QXRH --json
agent-device click @e34 --platform android --serial R3CX105QXRH --json
agent-device screenshot /tmp/mobile-terminal.png --platform android --serial R3CX105QXRH --json
orca terminal send --terminal term_926b8898-f843-461a-acd2-482f741327ad --text r --json
orca terminal read --terminal term_926b8898-f843-461a-acd2-482f741327ad --json
```

## Next Debug Boundary

Do not repeat WebView readiness tests unless the WebView changes again; the WebView can render post-init writes. For future regressions, run the no-phone repro first. If it fails, debug the WebSocket/runtime/PTY bridge before touching the mobile UI. If it passes but the phone is blank, debug `TerminalWebView` or session-screen routing.
