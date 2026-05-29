# Worktree Sidebar Drag Autoscroll

## Problem

The left sidebar supports reordering worktree rows, but holding a drag near the top or bottom of the scrollable sidebar does not continue scrolling.

- `src/renderer/src/components/sidebar/WorktreeList.tsx:399` keeps active worktree drag state and cached group rects.
- `src/renderer/src/components/sidebar/WorktreeList.tsx:757` computes the drop from `clientY`, the current sidebar `getBoundingClientRect()`, and `scrollTop`.
- `src/renderer/src/components/sidebar/WorktreeList.tsx:1400` updates the custom pointer drag only after pointer events.
- `src/renderer/src/components/sidebar/WorktreeList.tsx:1660` uses the native drag path for card drag start/over/drop.
- `src/renderer/src/components/sidebar/WorktreeList.tsx:1920` renders the scroll container as `[data-worktree-sidebar]`.

## Current Behavior

The custom pointer path promotes to an active drag after `SIDEBAR_POINTER_DRAG_THRESHOLD_PX`, creates a fixed preview, stores a `WorktreeDragSession`, and schedules `flushWorktreePointerDrag()` on pointer movement. Drop still uses `computeWorktreeDrop()` and `onReorderWorktrees()`. If `computeWorktreeDrop()` returns null, pointer drops may instead pin or move the worktree to a workspace status target.

The native HTML5 handlers still exist: they store the same `WorktreeDragSession` on `onCardDragStart`, compute the reorder preview in `onDragOver`, commit through `onDrop` or the capture-phase document drop handler, and clear on `onCardDragEnd` through `WorktreeCard`. In the current list rendering, `WorktreeCard` is passed `nativeDragEnabled={false}`, so the active user-facing worktree reorder path is the custom pointer path. If the native handlers remain in place, keep them consistent; workspace status/pin drops are already handled by `useWorkspaceStatusDocumentDrop()`.

Scroll bookkeeping already exists. `handleScroll()` calls `markScrollMovement()`, which suppresses virtualizer measurement correction. Direct wheel/touch/scrollbar input additionally calls `markDirectScrollInput()`, which blocks anchor restoration retries. Autoscroll must mark programmatic movement, not direct user input.

## Root Cause

Both drag paths are event-driven. When the pointer is held at a sidebar edge, no frame loop changes `scrollTop`; without a scroll change, the virtualized list does not reveal farther rows and `computeWorktreeDrop()` keeps evaluating against the same viewport.

There is also a virtualization constraint: `computeWorktreeDrop()` only considers `worktreeDragSessionRef.current.rects`, which are a snapshot of the source group's mounted rows at drag start. Autoscroll would reveal new rows but still reject drops outside the original snapshot unless the active session refreshes its source-group rects from the current DOM. Refreshing rects must stay limited to the same `sourceGroupKey`; ordering still commits through the existing `worktreeDragUnitGroups`, `getFullDropIndexForWorktreeDragUnit()`, and `onReorderWorktrees()` path.

## Non-Goals

- Do not change manual ordering, rank persistence, group membership, lineage expansion, selection, pinning, or workspace status semantics.
- Do not change the workspace board drawer drag behavior.
- Do not add settings, controls, new visual affordances, IPC, persistence, SSH, filesystem, or git-provider behavior.

## Design

1. Add a concrete helper for sidebar drag autoscroll, for example `worktree-sidebar-drag-autoscroll.ts`. It should compute a bounded next `scrollTop` from:
   - latest pointer `clientX`/`clientY`;
   - container bounds;
   - `scrollTop`, `scrollHeight`, and `clientHeight`;
   - elapsed frame time, clamped so a throttled/background frame cannot jump the list.
2. The helper must return no-op when the pointer is outside the container horizontally, the pointer is outside the vertical edge zones, or the container is already at the relevant scroll bound.
3. Add a small session refresh helper that replaces `worktreeDragSessionRef.current` with the latest `getWorktreeDragRectsForGroup(scrollRef.current, session.sourceGroupKey)` result and revalidates the latest groups: `worktreeDragGroups` must still contain the source group and `session.draggingWorktreeId`, and `worktreeDragUnitGroups` must still contain `session.reorderUnitDraggedIds` for the same `sourceGroupKey`. Do not require every `session.reorderDraggedIds` entry to be in the source group, because the existing multi-select/lineage reorder path filters those ids during commit. If the source group or reordered unit ids disappear, clear the drag instead of committing stale ids.
4. Track autoscroll animation frame ids separately from `WorktreePointerDrag.frameId`. The existing `frameId` is for preview/drop flushing; sharing it would make it easy to cancel the wrong work or skip a needed preview update.
5. Pointer drag path:
   - start autoscroll only after `beginWorktreePointerDrag()` promotes the drag to active;
   - each autoscroll frame reads the latest `drag.currentX/currentY`;
   - apply `container.scrollTop = nextScrollTop` only when it changes;
   - call `markScrollMovement()` before or immediately after the scroll write instead of `markDirectScrollInput()`;
   - refresh source-group rects from the mounted DOM before recomputing a drop; if the virtualizer has not rendered the newly exposed rows yet, keep the current null-drop behavior for that frame;
   - schedule `scheduleWorktreePointerDragFrame(drag)` after a scroll write so the preview line is recomputed against the new `scrollTop` and refreshed rects.
6. Native drag path, if it is kept or re-enabled:
   - store the latest native drag-over `clientX/clientY` in a small ref while a `WorktreeDragSession` exists;
   - run a separate autoscroll frame loop from `onDragOver`;
   - after a scroll write, refresh source-group rects, recompute the native drop preview from the stored `clientY`, and update `worktreeDragState`;
   - set `event.dataTransfer.dropEffect = 'move'` only inside real `dragover`/`drop` event handlers when the current drop is valid. A RAF callback cannot update the native drag cursor/effect; it can only update sidebar preview state until the next native drag event.
7. Cleanup must cancel both pointer and native autoscroll loops on drop, document drop, dragend, pointerup, pointercancel, document visibility loss, component unmount, and `clearWorktreeDrag()`.

Keep the implementation local to the renderer sidebar. The scroll container remains `scrollRef.current`; do not query arbitrary sidebars globally.

## Data Flow

Pointer:

- Pointer down snapshots source-group rects and arms a non-active pointer drag.
- Pointer move beyond the threshold promotes to active, creates the preview, stores the drag session, and starts autoscroll.
- Autoscroll frames update `scrollTop` when the latest pointer point is in an edge zone.
- After each scroll write, the active session refreshes source-group rects from the current DOM and the normal pointer drag frame recomputes the drop preview using the existing `computeWorktreeDrop()`.
- Pointer up commits through the existing `onReorderWorktrees()` path, or through the existing pin/status fallback when no reorder drop is valid.

Native:

- If enabled, native drag start stores the drag session and cached source-group rects.
- Native drag over stores the latest point, computes the current drop, and starts autoscroll.
- Autoscroll frames reuse the latest stored point to update scroll, refresh source-group rects, and recompute preview. They do not try to set `DataTransfer.dropEffect`.
- Native drop/document drop commits through the existing reorder path; dragend clears state.

## Edge Cases

- Top and bottom bounds: do not keep writing the same `scrollTop`.
- Horizontal outside: no sidebar autoscroll if `clientX` is left or right of the scroll container.
- Vertical outside: allow scrolling when `clientY` is at or slightly beyond the top/bottom edge, but cap speed.
- Threshold: custom pointer autoscroll must not start before the existing drag threshold.
- Native event sparsity: continue from the last known drag-over point while events pause, but stop on dragend/drop/visibility loss.
- Drop validity while scrolling: if refreshed source-group rects still do not cover the pointer after scroll, preserve the current null-drop behavior rather than guessing a new index.
- Virtualized rows: rows can mount/unmount while scrolling. Refresh rects from `[data-worktree-drag-id]` for the source group only, and tolerate a frame where the virtualizer has not mounted newly visible rows yet.
- Source mutations: if the dragged worktree, source group, or reorder unit disappears during drag, clear the drag instead of committing against stale ids.
- Concurrent ordering changes: final drop should use the latest `worktreeDragGroups`/`worktreeDragUnitGroups` already captured by React callbacks, but the source group and reordered unit ids must be revalidated before commit. Do not rederive a different dragged set mid-drag.
- Multi-window/external mutations: this is renderer-local UI state. Do not persist autoscroll state or broadcast it; external list mutations should only invalidate or clear the active drag.
- Workspace status and pin targets: preserve pointer fallback behavior and do not make native reorder autoscroll steal document-level status/pin drops. The capture-phase document reorder handler should only prevent default/stop propagation when `computeWorktreeDrop()` returns a valid reorder drop.
- Unmount/remount: cancel animation frames and remove previews/styles in the existing cleanup path.

## Test Plan

- Unit: add tests for the autoscroll calculation helper covering top edge, bottom edge, middle no-op, horizontal outside, scroll bounds, capped speed, and elapsed-time scaling.
- Unit: add tests for the rect/session refresh helper with same-group refresh, missing source group, missing dragged ids, and empty mounted rects.
- Unit: add tests for any extracted native/pointer loop coordinator only if it can run without a full virtualized React render.
- Unit: keep `worktree-manual-order.test.ts` and `worktree-drag-units.test.ts` passing to prove rank and drag-unit semantics did not change.
- Typecheck/lint: run `pnpm run typecheck` and `pnpm run lint`.
- Focused tests: run `pnpm test -- src/renderer/src/components/sidebar/worktree-manual-order.test.ts src/renderer/src/components/sidebar/worktree-drag-units.test.ts` plus the new autoscroll helper tests.
- Electron/manual: validate a long worktree list by dragging near the bottom until the list scrolls, dropping, then dragging near the top until it scrolls back. Also smoke native drag if it is reachable in the current app configuration.

## UI Quality Bar

Follow `docs/STYLEGUIDE.md` and the existing sidebar tokens. This change should not introduce new colors, shadows, controls, or copy. The only visible behavior change is smooth scrolling while dragging near the sidebar edge. The existing floating preview, insertion line, row opacity, status/pin highlights, focus ring, and sidebar scrollbar styling should remain unchanged.

No clipping, flicker, stuck insertion line, unexpected row jump, or preview lag should appear during autoscroll.

## Review Screenshots

Required evidence:

1. Sidebar precondition with enough worktrees to scroll.
2. Pointer drag held near the bottom edge after autoscroll advances the list, with preview and insertion line visible.
3. Pointer drag held near the top edge after autoscroll moves back upward, with preview and insertion line visible.
4. Final dropped order visible in the sidebar.

Optional evidence if native drag is enabled in the tested build:

5. Native drag autoscroll in progress or a note explaining why native drag could not be exercised.

Do not commit evidence images.

## Rollout

1. Add `worktree-sidebar-drag-autoscroll.ts` and focused unit tests.
2. Add session rect refresh/revalidation and use it before drag preview/drop recomputation during active autoscroll.
3. Wire custom pointer-drag autoscroll with separate frame cleanup.
4. If the native handlers remain supported or are re-enabled, wire native drag-over autoscroll with latest-point storage and document dragend/drop cleanup, keeping `dropEffect` writes inside drag events.
5. Run typecheck, lint, focused sidebar tests, and Electron validation with screenshots.

## Lightweight Eng Review

- Scope: correctly limited to the worktree sidebar drag paths. The plan must not touch persistence, ordering algorithms, workspace board drawer drag, SSH, filesystem, or git-provider code.
- Architecture/data flow: renderer-only helper is appropriate. Pointer and native drag should share the scroll calculation and rect refresh/revalidation, not necessarily the same animation-frame state, because their preview/drop update paths differ.
- Failure modes: frame leaks, stale last drag-over points, redundant bound writes, stale session ids after external mutations, virtualization gaps, document-level status/pin drops, invalid `dropEffect` assumptions, and unmount cleanup are in scope.
- Tests: pure scroll helper and rect-refresh tests are required. Full virtualized pointer behavior is not a good jsdom target; use focused unit tests plus Electron/manual validation. Existing manual-order tests are regression tests only, not evidence that autoscroll works.
- Performance/blast radius: one RAF loop per active drag path is acceptable only while a drag session exists. Avoid layout thrash by reading container rect once per frame before writing `scrollTop`, and avoid React state writes when the recomputed preview is unchanged.
- UI quality: no new design surface. Verify smoothness, insertion-line accuracy, existing preview styling, and absence of row jumps against the style guide.
- Screenshot requirement: screenshots are required for review evidence but must not be committed.
- Residual risks: native drag event behavior differs across Electron/platforms, and virtualized rows may lag one frame behind programmatic scroll writes. Validate the main pointer path first and explicitly document any native limitation found during implementation.
