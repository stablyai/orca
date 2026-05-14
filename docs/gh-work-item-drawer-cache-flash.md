# GitHub Work Item Drawer: Fix Reopen Flash

## Symptom

After #1655, reopening a GH issue/PR drawer can still flash a loading/skeleton frame before cached content appears.

## Verified root cause

`GitHubItemDialog` currently paints from component state (`details`, `loading`, `error`) that is updated in an effect (`src/renderer/src/components/GitHubItemDialog.tsx:2480+`).

Current sequence on close/reopen of the same item:

1. Close path runs effect branch with no `workItem` and calls `setDetails(null)`.
2. Reopen renders once with `details === null`.
3. Effect reads `workItemDetailsCache` and then calls `setDetails(painted)`.
4. Second render shows cached content.

With sheet animation, that first empty paint is visible as a flash.

## Refactor direction

Move drawer paint state to the module cache and subscribe with `useSyncExternalStore`. The drawer should read the cache entry synchronously during render.

This is not optional if we want reopen to paint cached content on first render.

## Required cache-store changes

Add a store subscription layer around `workItemDetailsCache`:

- `subscribeWorkItemDetailsCache(listener)`
- `notifyWorkItemDetailsCache()`

Call `notifyWorkItemDetailsCache()` after every actual cache mutation:

- `touchWorkItemDetailsCache`
- `invalidateWorkItemDetailsCacheForKey`
- `invalidateWorkItemDetailsCacheByMatch`

Also increment `workItemDetailsCacheGeneration` on **all** invalidations, not only `invalidateWorkItemDetailsCacheByMatch`. Otherwise an in-flight fetch launched before exact-key invalidation can repopulate stale data.

## `useSyncExternalStore` contract details

Use:

```ts
const cachedEntry = useSyncExternalStore(
  subscribeWorkItemDetailsCache,
  () => (detailsCacheKey ? workItemDetailsCache.get(detailsCacheKey) : undefined)
)
```

Important constraints:

- `getSnapshot` must return a referentially stable value when store data has not changed.
- Returning the map entry object is valid **only if** writes replace entry identity (`delete+set` with a new entry object).
- Do not build fresh wrapper objects in `getSnapshot` (that would violate stability and can cause render loops).

## Component state changes

Remove component-local `details/loading/error` state for work-item details.

Derive view state from `cachedEntry`:

- `details = cachedEntry?.details ?? null`
- blocking `loading = !!cachedEntry?.pending && !cachedEntry?.details`
- blocking `error = cachedEntry?.error && !cachedEntry?.details ? cachedEntry.error : null`

Keep stale-on-error behavior by preserving `details` in cache while setting `error`.

## Effect responsibilities after refactor

The main effect should:

- handle item-change bookkeeping (`prevItemIdRef`, `optimisticCommentsRef`, `setTab`)
- decide freshness and in-flight dedupe
- launch fetch and write results/errors/pending back into cache

The effect should not call `setDetails`, `setLoading`, or `setError` for work-item details.

## Optimistic comment race and merge rules

`appendOptimisticComment` must write through cache only (no local `setDetails`).

Rules:

- push comment into `optimisticCommentsRef`
- patch cache entry comments (if present), mark stale (`fetchedAt: 0`), notify
- derive rendered comments from cached details plus optimistic refs

Dependency pitfall:

- do not depend on a freshly-created array from `optimisticCommentsRef.current` in `useMemo`
- memo should key off stable signals (cache entry identity); cache notifications will re-render after optimistic writes anyway

This avoids unnecessary recomputation and avoids accidental infinite rerender patterns from unstable deps.

## Invalidation while drawer is open

When `invalidateWorkItemDetailsCacheByMatch` deletes the current key while drawer is mounted:

- subscription notifies immediately
- render sees `cachedEntry === undefined`
- UI falls back to loading/empty state and effect triggers refetch

This is expected and preferred over showing stale state.

## Fetch race constraints (must keep)

Keep current protections:

- per-key in-flight dedupe via `entry.pending`
- generation guard to block stale writes after invalidation
- stale-on-null handling (`result === null` must not wipe existing valid cached details)

Add one missing consistency rule:

- if fetch resolves after invalidation and key was dropped, do not recreate entry unless generation still matches launch generation.

## Scope of deletion

Delete only the work-item-detail local state and call sites:

- `useState<GitHubWorkItemDetails | null>` (`details`)
- `useState<boolean>` (`loading`) for this data path
- `useState<string | null>` (`error`) for this data path
- corresponding `setDetails`/`setLoading`/`setError` calls in the details effect and optimistic comment append path

Do not touch unrelated loading/error state in other subviews.

## Expected result

Reopen of a cached item paints content on first render (no flash). Background refetch still runs when stale, and cross-window/local invalidations remain authoritative.
