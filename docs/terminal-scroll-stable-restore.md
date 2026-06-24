# Terminal Scroll Stable Restore

## Problem

Switching away from a workspace while a terminal TUI is scrolled near, but not at, the top or bottom can cause the viewport to jump or jitter when the workspace becomes visible again.

The previous fix direction preserved more state, but it restored too aggressively: repeated frame-by-frame scroll replays and scrollbar sync jiggles can fight xterm's clamp behavior near buffer edges. That makes the viewport visibly vibrate or briefly flash at the wrong position.

## Invariant

The terminal leaf owns the user's scroll position.

For a running terminal, Orca should prefer the live xterm viewport. When React visibility, WebGL suspend/resume, or layout fit temporarily disturbs xterm, Orca may restore the last visible viewport once after the disruptive operation settles.

## Model

Use a hybrid model:

1. Live mounted terminals keep using the existing in-memory visibility restore path.
2. Remounted terminals fall back to durable scroll state stored by stable layout leaf id.
3. Layout snapshots preserve the last visible leaf scroll state while the pane is hidden.
4. Programmatic restore does not overwrite the stored user position.
5. Hidden/background PTY output can update terminal contents, but it must not redefine the user's visible scroll anchor unless the user is following output at the bottom.

## Non-Goals

- Do not replay scroll position for many animation frames during a workspace transition.
- Do not infer durable user position from hidden xterm viewport values.
- Do not serialize xterm marker objects into session state.
- Do not change PTY ownership, SSH/runtime snapshot semantics, or scrollback persistence.

## Implementation Plan

1. Add `scrollStatesByLeafId` to `TerminalLayoutSnapshot`, schema validation, and leaf-id remapping.
2. Capture primitive scroll state by leaf id when the terminal is visible.
3. Preserve prior `scrollStatesByLeafId` when the terminal is hidden so hidden WebGL/layout churn cannot persist `viewportY = 0`.
4. On visible remount/resume, restore the saved leaf state once after layout using the existing deferred layout restore helper.
5. Avoid repeated transition restore loops and repeated scrollbar jiggles.
6. Add focused tests for schema/remapping, hidden preservation, and single-shot leaf restore behavior.

## Validation

- Unit tests for scroll restore primitives and terminal layout persistence.
- Existing visibility resume tests to ensure the live mounted path still restores after fit.
- Real Codex TUI E2E with enough scrollback: scroll near bottom, switch workspaces, switch back, assert no top jump and final viewport remains near the saved position.
