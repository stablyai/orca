# Right Sidebar Header Drag Region

## Problem

Right sidebar header blank space does not drag the window.

- In top mode, the header row (`right-sidebar/index.tsx`, current line ~313) has no `-webkit-app-region: drag`.
- In side mode, the title row (`right-sidebar/index.tsx`, current line ~332) has no `-webkit-app-region: drag`.
- The app already uses draggable titlebar surfaces elsewhere (`.titlebar`, `.titlebar-left` in `main.css`), so this is an inconsistency.

## Current Behavior (Verified)

- `ActivityBarButton` renders plain `<button>` elements with no `no-drag` class.
- Close button is already safe because `.sidebar-toggle` sets `-webkit-app-region: no-drag`.
- Top-mode activity bar context menu is currently bound to the full header row via `ContextMenuTrigger`.
- Side-mode activity bar context menu is bound to the side icon strip, not the side-mode title row.

## Constraints That Matter

- `-webkit-app-region: drag` is required for Electron window drag hit-testing.
- Interactive descendants inside a drag region must be `-webkit-app-region: no-drag`, or click behavior becomes unreliable.
- Do not depend on blank-space right-click inside a drag region for opening menus; attach context-menu trigger to a guaranteed `no-drag` target.
- No visual/layout changes; keep existing Windows inset behavior (`right-sidebar-header-inset`, `right-sidebar-header-side-inset`, `side-activity-bar-windows-inset`).

## Design

1. Add utility classes in `src/renderer/src/assets/main.css`:
   - `.right-sidebar-header-drag { -webkit-app-region: drag; user-select: none; }`
   - `.right-sidebar-header-no-drag { -webkit-app-region: no-drag; }`
2. Apply `.right-sidebar-header-drag` to both header wrappers:
   - top activity-bar row
   - side-mode title row
3. Apply `.right-sidebar-header-no-drag` to all interactive header descendants:
   - `ActivityBarButton` root button
   - top-mode icon-row wrapper that owns context-menu trigger
   - close button is already covered by `.sidebar-toggle` (keep as-is)
4. Move top-mode `ContextMenuTrigger` from the whole header row to a `no-drag` target (icon-row wrapper). Do not bind it to the drag surface.
5. Keep side-mode context-menu wiring on the side icon strip unchanged.

## Validation

- Top mode: blank area drags window.
- Top mode: tab icons click reliably; close button click remains reliable.
- Top mode: context menu opens from icon row (not blank drag area).
- Side mode: title/blank area drags; close button remains clickable.
- Left-edge resize handle remains usable (`z-10`, absolute overlay).
- Windows: overlay controls do not cover close button/icons after insets.
- Sidebar closed (`width: 0`, `overflow-hidden`): no leaked hit targets.

## Concurrency / Consistency

- Multi-window safe: renderer-local CSS/DOM only, no shared mutable state.
- Store updates (`activityBarPosition`, `rightSidebarTab`, `rightSidebarOpen`) are safe: drag/no-drag is static class wiring on re-rendered elements.
- No IPC or async cross-process dependency, so no invalidation races introduced.
