# Cmd+J empty-query ordering: use visit recency, not activity recency

## Problem

When Cmd+J opens with no query, the `sortedWorktrees` memo in
`WorktreeJumpPalette.tsx` orders the Worktrees section by
`Worktree.lastActivityAt` before the empty-query cap is applied. The cap is
conditional: with browser tabs present, Worktrees is capped at 5 so browser
rows stay visible above the fold (see the `__hint_worktree_cap__` branch in
the same file); with no browser tabs, the list is uncapped.

For worktrees with low background signal — notably SSH-backed worktrees —
`lastActivityAt` can remain old even when the user was just working there.
Those worktrees get pushed below the visible empty-query rows by local
worktrees that emitted incidental PTY/activity events. The user then has to
type a substring to surface the worktree they just visited, which defeats
the purpose of the empty-query switcher.

Reported symptom: an SSH worktree the user was working in minutes ago does
not appear in the visible Cmd+J empty-query list; typing any substring
surfaces it.

## Product model

Cmd+J with an empty query is a fast switcher. It should answer: "where am I
likely to jump next?"

That is different from both existing recency signals:

- `lastActivityAt` answers "where did work happen?" Right for activity-aware
  surfaces, wrong for SSH or quiet worktrees where user focus is not
  accompanied by local PTY/activity signals.
- `worktreeNavHistory` (see `recordWorktreeVisit` in the
  `worktree-nav-history` slice) answers "what is the Back/Forward stack?"
  That stack has index, forward-history, duplicate, and `'tasks'` semantics
  that are useful for sequential navigation but unrelated to switcher
  ranking.

The switcher needs its own persisted focus-recency signal. This doc uses
"focus recency" throughout.

## Proposal

Persist a per-worktree focus-recency timestamp and use it as the primary
ordering signal for Cmd+J's empty-query Worktrees section.

Store shape, added to `src/renderer/src/store/slices/worktrees.ts` (the
slice that already owns `activeWorktreeId` and is the natural home for
per-worktree UI recency):

```ts
lastVisitedAtByWorktreeId: Record<string, number>
markWorktreeVisited: (worktreeId: string, visitedAt?: number) => void
```

`markWorktreeVisited` must be monotonic: if the supplied (or current)
timestamp is not strictly greater than the stored value, it is a no-op. This
matters because CLI-driven and IPC-driven activations can race, and we do
not want an older timestamp to regress recency.

### Stamp site

Stamp from `activateAndRevealWorktree` (`src/renderer/src/lib/worktree-activation.ts`),
**immediately after the `state.setActiveWorktree(worktreeId)` call at
line 91**, synchronously, before any of the later view/terminal/reveal
steps. This guarantees the stamp lands even if a subsequent async step
fails, since the user already perceives the switch as successful once
`activeWorktreeId` flips.

Do this *in addition to*, not gated on, the existing
`state.recordWorktreeVisit(worktreeId)` call; the nav-history slice has
different semantics (see "Why not use `worktreeNavHistory`").

Do **not** stamp from `setActiveWorktree` directly. That raw setter is
invoked by hydration, session restore, and test setup — stamping there
would reset focus recency for the restored workspace on every app launch.

### Activation-path audit

Every user-initiated worktree switch must route through
`activateAndRevealWorktree`. Before landing, audit direct callers of
`setActiveWorktree` and classify each:

- **User switches** (sidebar clicks, Cmd+J selections, CLI activations,
  status-bar/session jumps, deep links) — must go through activation.
- **Non-user transitions** (store hydration, session restore, tests) — must
  NOT stamp.

The audit output belongs in the PR description. Do not stamp
`Worktree.lastActivityAt`.

### Ordering rule (empty query only)

1. Start from visible worktrees: skip `isArchived`, and keep honoring
   `hideDefaultBranchWorkspace` via `isDefaultBranchWorkspace`.
2. Build a separate `switchableWorktrees` list that excludes the currently
   active worktree. Keep the full visible list for loading/empty-state/count
   logic so the palette never claims there are no worktrees just because the
   only visible worktree is current.
3. Sort `switchableWorktrees` by:
   - `lastVisitedAtByWorktreeId[id]` descending, when present.
   - `lastActivityAt` descending as the fallback for never-visited or
     pre-migration worktrees.
   - `displayName.localeCompare` as the final stable tie-breaker.
4. Preserve the conditional cap: cap Worktrees at 5 only when browser rows
   exist (the existing `__hint_worktree_cap__` logic); otherwise leave the
   Worktrees section uncapped.
5. Preserve the existing "Type to see all N worktrees" hint, but compute `N`
   from switchable rows. Empty-state copy is based on the full visible list.

Typing any non-empty query still routes through `sortWorktreesSmart`. No
change to the sidebar, `sortEpoch`, or `lastActivityAt` semantics.

### Current worktree handling

Cmd+J is a switch surface. Exclude the current worktree from empty-query
rows in v1. Keep two separate lists so empty-state logic is not affected:

- `visibleWorktreesForState`: includes the current worktree and drives
  "loading", "has any worktrees", and empty-state decisions.
- `switchableWorktreesForRows`: excludes the current worktree and drives the
  actual empty-query Worktrees rows.

A "Current" row variant is out of scope.

## Why not use `worktreeNavHistory`

`worktreeNavHistory` records activations but is the wrong abstraction for
Cmd+J ordering.

- Back/Forward history is an indexed stack. Cmd+J is an unordered switcher
  ranked by likely target.
- History contains `'tasks'` entries; Cmd+J rows should not need to
  understand task-page sentinels.
- Back/Forward navigation can leave forward entries in the stack. A raw
  newest-to-oldest walk either incorrectly includes future entries or needs
  custom interpretation of `worktreeNavHistoryIndex`.
- History dedupe rules are stack-oriented. A per-worktree timestamp is
  simpler and directly models the switcher need.

Keep `worktreeNavHistory` for Back/Forward.

## Migration and persistence

Persist `lastVisitedAtByWorktreeId` via the same zustand persist path that
survives app restart.

- **Downgrade:** older builds will drop the unknown key on rehydrate
  (zustand `partialize` strips anything the slice doesn't declare). No
  custom migration needed; record this explicitly in the PR so nobody
  invents one.
- **Pruning:** drop entries whose worktree IDs are no longer present —
  **after worktree hydration completes**, not on raw rehydrate. Repos load
  async; pruning too early would nuke timestamps for worktrees whose repo
  hasn't yet hydrated.
- **Seeding active on restore:** if, after hydration, the active worktree
  has no stored timestamp, seed it with the current time from the
  hydration-complete handler — not by calling `markWorktreeVisited` from
  `setActiveWorktree`. The two paths have intentionally different
  semantics (seeding is a migration fixup; stamping is focus recency).
- Never-visited worktrees stay without timestamps and fall back to
  `lastActivityAt`.

The map is bounded by live worktree IDs, so no history cap is needed.

## Non-goals

- Changing sidebar sort order.
- Changing `lastActivityAt` semantics or when it is stamped.
- Changing the typed-query path; smart-sort remains authoritative.
- Making Cmd+J mirror Back/Forward history.
- Persisting Cmd+J UI state such as query, scroll position, or selection.
- Adding a "Current" row variant.

## Implementation sketch

- Add `lastVisitedAtByWorktreeId` and `markWorktreeVisited` to the
  `worktrees` slice; persist via the existing persist config.
- In `activateAndRevealWorktree`, call `markWorktreeVisited(worktreeId)`
  immediately after `state.setActiveWorktree(worktreeId)` (line 91),
  synchronously. Focus recency, not work activity.
- Update the `sortedWorktrees` memo in `WorktreeJumpPalette.tsx` so the
  empty-query branch uses subscribed store inputs:
  `lastVisitedAtByWorktreeId`, `activeWorktreeId`, visible worktrees, and
  existing palette filters. Avoid reading `useAppStore.getState()` inside a
  memo as the only source of ordering data; that can produce stale UI.
- Keep the typed-query branch on `sortWorktreesSmart`.
- Keep browser-tab search ordering unchanged unless a separate browser
  visit-recency issue is discovered.
- Extract a pure function `orderEmptyQueryWorktrees` so ordering,
  current-worktree exclusion, and fallback behavior are testable without
  mounting the whole palette.

## Tests

Add focused tests for the ordering helper:

- Recently visited SSH/quiet worktree ranks above a locally active worktree
  with newer `lastActivityAt`.
- Never-visited worktrees fall back to `lastActivityAt`.
- Current worktree is excluded from empty-query rows but still counted for
  empty-state logic.
- Worktrees cap remains conditional on browser rows.
- `hideDefaultBranchWorkspace` and `isArchived` still filter rows.
- Non-empty query still uses `sortWorktreesSmart` order.
- Hydration seeds the active worktree's timestamp when missing.
- `markWorktreeVisited` is monotonic: an older timestamp does not regress
  the stored value.

Do not put these tests in `worktree-palette-search.test.ts` unless the pure
search function itself changes. That file verifies matching behavior and
input order preservation, not empty-query ranking.

## Risks

- **Activation paths that bypass `activateAndRevealWorktree`.** Any
  user-visible switch that calls `setActiveWorktree` directly will skip the
  stamp. Mitigation: the activation-path audit above.
- **False empty states after current-worktree exclusion.** Mitigation:
  separate `visibleWorktreesForState` and `switchableWorktreesForRows`.
- **Pruning before hydration.** Mitigation: prune in the
  hydration-complete handler, not on raw rehydrate.
