# Floating Terminal Panel Position Persistence

## Problem

The floating workspace panel appears in a different default location after app restart instead of returning to the user's last dragged or resized placement.

- `src/renderer/src/components/floating-terminal/FloatingTerminalPanel.tsx:132` initializes panel `bounds` from `getDefaultFloatingTerminalBounds()` on every renderer mount.
- `src/renderer/src/components/floating-terminal/FloatingTerminalPanel.tsx:349` only normalizes that in-memory initial state when the panel opens; it does not read or write durable position state.
- `src/renderer/src/components/floating-terminal/FloatingTerminalPanel.tsx:1039` updates bounds while dragging, and `src/renderer/src/components/floating-terminal/FloatingTerminalResizeHandles.tsx:98` updates bounds while resizing, but both changes remain React state only.
- The toggle button already persists its own location through localStorage in `src/renderer/src/components/floating-terminal/FloatingTerminalToggleButton.tsx:33`, so the inconsistency is isolated to the larger panel.

## Root Cause

Panel geometry is transient renderer state. Restarting Orca remounts `FloatingTerminalPanel`, so the panel recomputes from the current viewport instead of restoring the last user placement. The component also has no source tracking, so its legacy right-gap normalization cannot distinguish a default position from an intentional user drag.

## Non-Goals

- Do not change terminal, browser, or markdown tab persistence.
- Do not persist remote or SSH-specific state; panel geometry is local renderer chrome.
- Do not persist maximized panel bounds as the normal restored size.
- Do not add new settings UI or change design tokens.

## Design

1. Add floating panel bounds persistence helpers beside the existing panel bounds math:
   - use a panel-specific versioned key, e.g. `orca-floating-terminal-panel-bounds-v1`;
   - parse only finite `left`, `top`, `width`, and `height` numbers;
   - distinguish `default` versus `user` bounds sources;
   - expose a panel viewport-usability guard so saved user bounds are not clamped against Electron's transient zero-sized startup viewport;
   - expand clamping to normalize both position and size. The current `clampFloatingTerminalBounds` only clamps `left` and `top`; persisted restores also need the resize-handle width/height caps.
2. Read and write storage defensively:
   - `window` absence or `localStorage` get/set failures fall back to in-memory behavior for the session;
   - malformed, partial, non-finite, or non-object JSON falls back to default bounds.
3. Initialize `FloatingTerminalPanel` once from persisted bounds when present, otherwise from the current default. Store the initial source in a ref, mirroring the toggle button pattern.
4. Reconcile bounds in `useLayoutEffect` before first paint and on viewport resize:
   - default-sourced bounds re-anchor to the current bottom-right default;
   - user-sourced bounds clamp into the visible viewport and persist the clamped result only after the viewport is usable;
   - remove `normalizedInitialBoundsRef` and the `rightGap > 160` reset. That heuristic is superseded by source-aware reconciliation and would otherwise wipe valid saved left-side placements.
5. Replace direct `setBounds` calls for user-driven placement changes with a panel-local geometry updater:
   - drag and resize pointer moves should clamp and update React state for smooth feedback, but stage the latest bounds in a ref;
   - pointer up and pointer cancel commit the staged bounds to storage only after movement produced staged geometry. `localStorage.setItem` is synchronous, so do not write on every pointer move or after a titlebar click with no movement;
   - the panel-level `onMouseUp` size capture must not convert a default-sourced panel into a user-sourced panel after an ordinary click. Commit measured dimensions only after a real geometry interaction, or when the panel was already user-sourced;
   - resize handles should receive explicit preview/commit callbacks instead of the raw React setter, so resize, drag, and restore use the same persistence rules.
6. When entering maximized mode, store the pre-maximized bounds and source in memory only. Do not persist the maximized rectangle. While maximized, viewport resize should recompute maximized bounds without touching the stored normal bounds or source. On restore, return to the stored normal bounds, reconcile them through the same source-aware rules, and persist only if the restored source is `user`.

## Consistency Model

- Persistence is a restart seed, not live cross-window synchronization.
- Multiple renderer windows share the same localStorage key and therefore use last-writer-wins across restarts/reloads. Do not subscribe to `storage` events for live updates; another window or DevTools edit should not move an open panel mid-drag.
- External storage mutations are picked up on the next renderer mount or reload.
- The state is local renderer chrome. It must not go through worktree settings, terminal state, or SSH-backed runtime APIs.

## Edge Cases

- Malformed or partial localStorage JSON falls back to default bounds.
- Unavailable localStorage should not break the floating workspace; persistence simply becomes best-effort.
- Startup can briefly report a zero-sized renderer; saved user bounds must not be clamped to that unusable viewport.
- A saved position from a larger monitor should be clamped back on-screen on the current monitor.
- A saved size larger than the current viewport should shrink to the largest size that still leaves a small visible margin while respecting minimum panel dimensions.
- A viewport smaller than the minimum panel size should keep the panel at the minimum size and keep its top-left corner reachable.
- Maximized mode should not overwrite the normal saved size and position.
- Plain clicks inside a default-positioned panel should not make that default position sticky forever.
- Pointer cancellation should commit the last valid drag or resize bounds, matching pointer-up behavior.
- SSH-backed terminals keep using the same floating workspace UI; geometry persistence stays local and does not assume local command execution.

## Rollout

1. Extend `floating-terminal-panel-bounds.ts` with parse, source, viewport usability, resolve, and size-aware clamp helpers plus focused unit coverage.
2. Wire `FloatingTerminalPanel` to read, reconcile, and persist panel bounds through those helpers; remove the legacy right-gap normalization.
3. Update `FloatingTerminalResizeHandles` to use preview/commit callbacks so drag, resize, measured-size capture, and maximize restore share one persistence path.
4. Add component coverage for persisted startup, bad storage, zero-sized startup deferral, default re-anchoring, user clamping, and the "plain click does not persist default" case.
5. Run focused Vitest coverage, then `pnpm typecheck` and `pnpm lint`.
6. Verify in Electron by moving/resizing the panel, reloading or restarting the dev app, checking maximized restore, and confirming evidence screenshots are not committed.
