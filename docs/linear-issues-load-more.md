# Linear Issues Load More

## Problem

- `src/renderer/src/components/TaskPage.tsx:288` defines `LINEAR_ITEM_LIMIT = 36`.
- The plain Linear Issues tabs fetch with that fixed limit in `TaskPage.tsx:4678` and store only `LinearIssue[]`, so All/Assigned/Created/Completed have no `hasMore` state and no in-app way to request more rows.
- `src/main/linear/issues.ts:291` returns `Promise<LinearIssue[]>` from `listIssues`. The current list GraphQL queries also do not request `pageInfo`, so the main process cannot infer whether Linear has more results.
- `src/main/ipc/linear.ts:115` and `src/main/runtime/orca-runtime.ts:12415` clamp plain issue list reads to 50. A 36-row "Load more" step would request 72 but receive at most 50 unless these clamps change.
- Project and custom-view issue reads already return `LinearCollectionResult<LinearIssue>` and render `LinearCollectionNotice`, but their backend helpers cap at 50 and only expose a passive "Search or open Linear" message.

## Goal

Let users browse more issues from the Linear Issues All tab inside Orca with an explicit "Load more" action. Apply the same plain-list behavior to Assigned, Created, and Completed because they share the same store/runtime/main read path.

## Non-Goals

- Do not add cursor-based infinite scrolling.
- Do not change Linear search behavior; search can stay capped and relevance ordered.
- Do not add load-more behavior to project/custom-view issue lists in this change.
- Do not change Linear auth, workspace selection, team filtering semantics, or issue mutation behavior.

## Design

1. Return collection metadata from plain issue list reads.
   - Change main `listIssues` to return `LinearCollectionResult<LinearIssue>`.
   - Add `pageInfo { hasNextPage }` to `ALL_ISSUES_QUERY`, `VIEWER_ASSIGNED_ISSUES_QUERY`, and `VIEWER_CREATED_ISSUES_QUERY`, and update `LinearIssueConnectionResponse` accordingly.
   - Keep `searchIssues` returning `LinearIssue[]`; it relies on Linear relevance order and should not get the load-more affordance.

2. Raise and align list limits deliberately.
   - Replace the current 50-item plain-list clamps in IPC and runtime with a named plain-issue-list max that is higher than one load-more step, for example 180 or 216. Keep the search clamp at 50.
   - Use the same clamp in local IPC and remote runtime paths. Do not let the renderer cache a request under limit 72 while the backend silently serves 50.
   - Main `listIssues` should clamp/floor its own `first` value too, so direct callers and future RPC paths cannot send unbounded GraphQL reads.
   - Keep project/custom-view clamps unchanged unless this feature explicitly expands those lists too.

3. Compute `hasMore` accurately.
   - For each workspace result, set `hasMore` from the connection `pageInfo.hasNextPage`.
   - For any multi-workspace plain-list read, also set `hasMore` when the merged, sorted list is clipped to the effective limit. This is not limited to the All preset; Assigned, Created, and Completed can also fan out across selected workspace `all`.
   - Sort and cap the merged list the same way the current implementation does. This remains a first-N refetch design, not cursor pagination.

4. Thread the envelope through IPC, runtime RPC, preload, and the renderer store.
   - Update `window.api.linear.listIssues`, `linearListIssues`, runtime RPC typing, preload API types, and `LinearSlice.listLinearIssues` to return `LinearCollectionResult<LinearIssue>`.
   - Plain list entries currently live in `linearSearchCache` under `linearListCacheKey`. Either keep that cache bucket and change the value type to support both arrays and collection results, or introduce a dedicated `linearListCache`. Do not mix raw arrays and envelopes under one declared `CacheEntry<LinearIssue[]>` type.
   - Split or retarget `inflightListRequests`/`InflightLinearListRequest` separately from search in-flight requests. The current shared in-flight type is `Promise<LinearIssue[]>`, which will be wrong once only list reads return an envelope.
   - Keep cache identity based on workspace, filter, and the effective clamped limit. Compute that effective limit before request signatures and cache keys; do not key a request by an unclamped value that the backend will silently reduce.
   - Existing generation and in-flight entry checks protect cache writes for the same key, but different limits are different keys. `TaskPage` still needs a latest-request guard so a slower 36-row promise cannot replace a newer 72-row window in component state.
   - Update `getCachedLinearIssues` or add a collection-aware cached read so `TaskPage` can keep existing rows visible while a larger window loads.
   - If plain lists keep using `linearSearchCache`, update every array-shaped consumer of that bucket, including `findTaskPageLinearIssue` and its `LinearSearchCache` alias in `task-page-cache-selectors.ts`, `patchLinearIssue`, and any `LinearSearchCache`/`LinearIssueReadArgs` test helpers. Otherwise a list envelope stored beside search arrays will break drawer lookup, row reconciliation, and optimistic patch propagation.

5. Add first-N "Load more" state in `TaskPage`.
   - Replace the fixed list-read limit with `linearIssueLimit` state initialized to `LINEAR_ITEM_LIMIT`.
   - Reset the limit to `LINEAR_ITEM_LIMIT` when workspace, preset, search query, Linear mode context, or selected project/custom-view changes back to the plain issue list.
   - For plain list reads, store `result.items` and `result.hasMore`; for search reads, keep the existing array path and no button.
   - On "Load more", increase by `LINEAR_ITEM_LIMIT`, fetch the larger first-N window, and leave current rows visible during the request.
   - The request signature and landing-refresh key must include the effective limit; otherwise a 36-row landing probe and a 72-row load-more request can be treated as the same request. Compare the resolving request's signature to the latest signature before setting `linearIssues` or `hasMore`.

6. Make the shared notice optionally actionable.
   - Extend `LinearCollectionNotice` with optional `onLoadMore`, `loading`, and label props.
   - Only render the button when `hasMore` and `onLoadMore` are both present.
   - Preserve the existing passive copy for project/view notices that do not pass a handler.
   - Use existing shadcn button primitives and styleguide tokens; keep the footer compact and keyboard reachable.

## Data Flow

- User opens Tasks -> Linear -> Issues -> All.
- `TaskPage` reads `linearIssueLimit`.
- Store calls `linearListIssues(settings, filter, linearIssueLimit, workspaceId)`.
- Local IPC or remote runtime calls main `listIssues(filter, effectiveLimit, workspaceId)`.
- Main requests `first: effectiveLimit` per selected workspace and returns `{ items, hasMore }`.
- `TaskPage` renders `items` and passes `hasMore` plus `onLoadMore` to `LinearCollectionNotice`.
- User clicks "Load more" -> `linearIssueLimit += 36` -> the effect refetches first N+36 and replaces the visible window when the newer request resolves.

## Edge Cases

- Search query is non-empty: do not show Load more; Linear search remains capped and relevance ordered.
- User switches preset, workspace, Linear mode, or selected project/view context: reset the plain issue limit to 36.
- Cached 36-row result exists and user requests 72: use a distinct cache key and keep 36 rows visible while fetching 72.
- Refresh while at 72 rows: force-refresh the 72-row window, not the initial 36-row window.
- Backend clamp reached: hide or disable Load more once the current limit equals the configured max, even if Linear reports `hasNextPage`.
- Multi-workspace reads: if any workspace has more pages or the merged rows are clipped, show Load more for any plain preset.
- Workspace failure in `all`: current plain `listIssues` swallows failures into `[]`; adding `errors` would be a behavior change. Either keep swallowing for this feature or deliberately adopt the project/view `errors` behavior and update UI/tests.
- Auth failure for a concrete workspace should still throw after clearing the token when `shouldThrowAuthError` says the whole request should fail.
- Team filtering happens after fetch and can hide rows. The notice count should use the unfiltered fetched count so users understand the loaded window size.
- External Linear changes between clicks can reorder first-N results because sorting is by `updatedAt`. This is acceptable, but the UI should replace the window rather than append blindly.
- Issue mutations currently patch cached rows they can find; they do not invalidate every first-N list window or pull newly eligible issues into the list. Manual refresh remains the consistency boundary.
- A lower-limit request already in flight can resolve after the user clicks Load more. It must not replace the larger visible window or clear the larger request's loading state.
- SSH/remote runtime: all reads must continue through runtime RPC or preload; no local-only Electron calls should be added.

## Test Plan

- `src/main/linear/issues.test.ts`: `listIssues` returns `{ items, hasMore }`, requests `pageInfo`, propagates connection `hasNextPage`, and marks `hasMore` when multi-workspace merged rows are clipped.
- Clamp tests for local IPC/runtime paths: plain list max is above 50 and aligned across local and remote; search remains capped at 50.
- `src/renderer/src/store/slices/linear.test.ts`: list cache stores the envelope shape, serves higher-limit cache independently, keeps lower-limit rows visible during higher-limit fetch, preserves drawer lookup and optimistic patching for cached list envelopes, and forced refresh still blocks stale overwrites.
- Store in-flight tests: list in-flight requests use the collection-result promise shape without changing search in-flight request behavior.
- `TaskPage` request-state test if available: a slower lower-limit response does not replace a newer higher-limit response or clear its loading state.
- `src/renderer/src/runtime/runtime-linear-client.test.ts`: local and remote `linear.listIssues` expect `LinearCollectionResult<LinearIssue>`.
- Component test if available: `LinearCollectionNotice` renders button, disabled/loading state, and no-handler passive copy.
- Electron validation: connected Linear All tab with Load more, pending state, post-load state, search mode without a button, and project/custom-view footer still using passive copy.

## UI Quality Bar

- The notice stays a compact footer matching existing bordered, muted Linear collection notices.
- The load-more action is visually secondary, keyboard reachable, and does not resize or overlap the issue list on narrow widths.
- While loading more, existing rows remain visible and the button clearly shows progress/disabled state.
- Copy is direct: users should understand Orca can fetch more without opening Linear.

## Review Screenshots

1. Linear Issues All tab showing Load more available.
2. Linear Issues All tab while a load-more request is pending.
3. Linear Issues All tab after more rows are loaded.
4. Linear Issues search results with no load-more button.
5. Linear project or custom-view issues footer still showing the old passive message.

## Rollout

1. Update shared/preload/runtime types for plain `listIssues` collection results.
2. Add `pageInfo` to main Linear issue list queries and return `items` plus `hasMore`.
3. Raise and align plain-list clamps in main, IPC, and runtime without changing search clamps.
4. Update renderer store caches and tests for the new list result shape.
5. Update `TaskPage` state/effects/rendering for first-N load more.
6. Update `LinearCollectionNotice` to accept an optional load-more action.
7. Run focused tests, `pnpm typecheck`, `pnpm lint`, and Electron screenshot validation.

## Lightweight Eng Review

- Scope: Correctly keeps the feature to first-N load more for plain issue tabs. It must not imply cursor pagination, because there is no cursor state or merge logic in the current store.
- Architecture/data flow: Main owns Linear `pageInfo` extraction and multi-workspace merge semantics; runtime/preload carry the envelope; the store owns envelope caching and stale-write guards; `TaskPage` owns visible window size and load-more UI.
- Failure modes: Current auth/network handling differs between plain issue lists and project/view collections. Preserve that difference unless explicitly changing it, and test whichever behavior is chosen.
- Concurrency: Include limit in request signatures, cache keys, landing probes, and force-refresh paths. A lower-limit response must not overwrite a newer higher-limit window.
- Consistency: First-N refetches can reorder rows after external updates, and optimistic issue patches do not make all list windows complete. This is acceptable only if the UI replaces the full window and refresh remains available.
- Performance/blast radius: No startup cost. Each click refetches first N per selected workspace, so multi-workspace All can multiply request cost. Keep a finite plain-list max and do not treat this as a free one-call operation.
- UI quality bar: Compact secondary action, stable layout, no overlap/clipping, clear loading state, and preserved passive project/view copy.
- Required screenshots: All tab available, pending, after load, search no-button, and project/view passive footer.
