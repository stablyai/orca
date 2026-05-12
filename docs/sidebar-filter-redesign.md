# Sidebar Repo Filter Redesign

## Problem

The current sidebar filter UI does not scale beyond a small repo count. Rendering every repo as a checkbox row in a menu creates poor scanability, high click cost, and clipping/scroll friction.

Constraints from current code:
- Filter semantics are store-driven (`showActiveOnly`, `hideDefaultBranchWorkspace`, `filterRepoIds`) and consumed by `computeVisibleWorktreeIds`.
- `searchRepos()` already provides ranking (display name first, path fallback).
- The trigger badge is the primary “filters active” affordance and must stay.

## Goals

1. Make repo filtering usable with large repo sets.
2. Keep toggle filters one click.
3. Add fast bulk actions (`All`, `None`, `Clear all`).
4. Preserve existing filter semantics and badge behavior.

## Non-goals

- No semantic changes to filtering logic in `visible-worktrees.ts`.
- No sticky-all persistence model like `RepoMultiCombobox`.
- No store schema migration.

## Correctness Notes (from code audit)

- `searchRepos()` is not debounced; it is synchronous `useMemo` filtering.
- Popover wheel rescue in `popover.tsx` only runs when the wheel handler is attached to a `PopoverContent` element that has class `popover-scroll-content`. Putting that class on an inner div does not activate the rescue path.
- `command.tsx` already includes a wheel fallback on `CommandList` for scroll-locked Radix Dialog parents.
- Sidebar filters are persisted via `window.api.ui.set` (debounced in `App.tsx`) and restored from persisted UI on launch.

## Proposed UI

Use `Popover` and keep trigger button/badge unchanged.

Popover sections:
1. Header: `Filters` + `Clear all` (shown only when any filter is active).
2. Toggle rows: `Active only`, `Hide default branch`.
3. Repo section (only when `repos.length > 1`):
   - Label + selected count.
   - `All` and `None` actions.
   - Search box (`Search repos...`).
   - Scrollable repo list with checkmark, repo dot/name, and SSH badge when `connectionId` exists.
   - Secondary path line for disambiguation when names collide.
4. Bottom action: `Add project` pinned below repo list.

## Implementation Decision: cmdk vs plain input

Use `Command` primitives (as in `repo-multi-combobox.tsx`) with `shouldFilter={false}` and feed pre-ranked `searchRepos()` results.

Why:
- Better keyboard behavior out of the box (arrow navigation, enter selection).
- Existing `CommandList` wheel fallback handles scroll-lock contexts that currently break plain inner-scroll regions.
- Consistent behavior with an existing repo selector pattern in the app.

## Edge Cases / Invalidation

- Repo removed while popover is open: selection count and rows derive from live `repos`; stale ids must not count toward badge or selected count.
- Repo added while open: `All` should include the new repo immediately (derive from current `repos` each render).
- External repo mutations (sync/import) during search: filtered list updates from live `repos`; empty-state must not hide `Add project`.
- SSH repos: show SSH indicator to avoid ambiguity with local repos of same display name.
- 0 or 1 repo: hide repo filter section. Keep `Add project` visible outside the repo-count gate so users can still recover from low-repo states.
- Multi-window: filter state is window-local; this redesign does not introduce cross-window synchronization.

## Accessibility / Focus

- Do not use `role="menuitemcheckbox"` unless the container is a true menu. Use semantic buttons or cmdk items with explicit `aria-selected`/checked indicators.
- Autofocus search on open.
- Esc closes via Radix Popover default.
- Ensure focus returns to trigger on close.

## Rollout

1. Replace sidebar filter content with Popover + Command-based repo list.
2. Keep `searchRepos()` as the only ranking source.
3. Keep current filter setters and badge derivation semantics.
4. Ensure scroll behavior works inside dialog parents by using `CommandList` (or by moving wheel handling to the actual scroll container).
5. Validate with `pnpm typecheck` and `pnpm lint`.

## Test Scope

- Unit coverage remains in `visible-worktrees` for filter semantics.
- Add/adjust component tests for:
  - keyboard navigation and selection,
  - stale repo id handling,
  - `All`/`None` behavior with live repo mutations,
  - `Add project` visibility at repo count 0/1.
