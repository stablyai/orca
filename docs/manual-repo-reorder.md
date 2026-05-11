# Manual repo reorder

## Problem

Current repo-header order in the sidebar is **not** `state.repos` insertion order.
`buildRows(..., groupBy='repo')` groups visible unpinned worktrees into a `Map`
and emits `Array.from(grouped.entries())`, so order follows first encounter in the
already-sorted visible worktree stream.

Result: users cannot control repo-group order, and sorting/filtering side effects can
change which repo appears first.

## Goal

Allow users to reorder repo headers in the sidebar when grouped by repo, persist that
order, and use it anywhere the UI lists repos.

## Non-goals

- Reordering worktrees within a repo group.
- Reordering PR-status groups, pinned section, or `All` header.
- Dragging worktrees between repos.
- Mobile/touch drag support.

## Design Decisions

1. Persist canonical order in `state.repos` array order (no new schema field).
2. Add `Store.reorderRepos(orderedIds)` in `src/main/persistence.ts`.
3. Add IPC `repos:reorder` in `src/main/ipc/repos.ts` and preload/API typing.
4. Add renderer action `reorderRepos(orderedIds)` in repo slice.
5. In `buildRows`, when `groupBy==='repo'`, order repo groups by a `repoOrder` map
   derived from `state.repos` (`repoId -> index`). Unknown ids sort last by label.

## Interaction Model (Important)

Do **not** use HTML5 DnD for this list.

`WorktreeList` uses `@tanstack/react-virtual` with absolutely-positioned rows moved by
`translateY`. During drag, rows can unmount/remount as scroll changes; HTML5 DnD target
and hover state are brittle in this setup.

Use pointer-driven drag state in React instead:

- Start drag from a dedicated drag handle on repo headers only (not full header).
- Keep collapse click behavior on header body unchanged.
- While dragging, render insertion indicator from computed target repo index.
- On drop, compute new `orderedIds` and call renderer `reorderRepos`.
- Cancel cleanly on escape, pointer cancel, blur, or invalid target.

Why handle-only: header already has click-to-toggle and nested buttons (`+`); dragging
from whole header conflicts with those interactions.

## Consistency and Invalidation

`repos:changed` already triggers `fetchRepos()` in `useIpcEvents`.

Implications:

- Renderer can optimistically reorder local `repos` immediately.
- Main persists reorder and emits `repos:changed`; renderer refetch should converge to
  the same order (no semantic conflict).
- If reorder is rejected (stale permutation due to concurrent add/remove), renderer must
  rollback by refetching.

`repos:reorder` should return a status (`applied | rejected`) so renderer can avoid
extra fetch on success and force resync on rejection.

## Edge Cases

- Concurrent repo add/remove while dragging: permutation validation rejects stale order;
  renderer refetches.
- Repo filtered out / no visible worktrees: repo stays in canonical `state.repos` order
  and reappears in correct position when visible again.
- `groupBy !== 'repo'`: no drag affordance.
- Dragging near viewport edges: support auto-scroll while pointer-dragging.
- Virtualization: keep drop computation independent of mounted DOM targets; do not
  require hovered row to stay mounted.
- Multi-window: last successful reorder wins via persisted array; each window resyncs on
  `repos:changed`.

## Implementation Plan

1. Add `reorderRepos(orderedIds)` to Store with strict permutation validation and save.
2. Add `repos:reorder` IPC handler; on success emit `repos:changed`.
3. Extend preload `repos` API and `src/preload/api-types.ts`.
4. Add renderer repo-slice action with optimistic local reorder + rejection resync.
5. Thread `repoOrder` into `buildRows` and add tests for explicit repo ordering.
6. Add pointer-based drag handle + insertion indicator to repo header UI in
   `WorktreeList.tsx`.
7. Manual validation: reorder, restart, filter/unfilter, collapse/expand, and
   cross-window conflict behavior.
