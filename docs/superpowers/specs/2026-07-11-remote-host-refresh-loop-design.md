# Remote Host Refresh Loop Design

**Issue:** [#8272](https://github.com/stablyai/orca/issues/8272)

**Review state:** Approved for implementation on 2026-07-11 after an independent Grok review.

## Problem

A macOS client connected to a Windows Orca runtime can briefly show the runtime's projects and then lose the runtime host section even though the connection and remote catalog remain healthy. The same session can also enter a Smart-order feedback loop that repeatedly rewrites remote `sortOrder` metadata, refreshes the remote catalog, and keeps the renderer busy.

The incident exposed two related defects:

1. Orca v1.4.135 merged local and runtime repo catalogs against a `repos` snapshot captured before an asynchronous fetch. A late local result could overwrite runtime repos added by an earlier-completing runtime result. Commit `25ecf2eea` already changed `main` to merge each catalog inside the Zustand state updater against the latest `state.repos`, but the local-versus-runtime overlap has no dedicated regression test.
2. Smart ordering persists every recomputed `sortedIds` array to its owner host. The runtime always writes fresh timestamp-based `sortOrder` values and emits `reposChanged`, even when the effective order is unchanged. The client refreshes worktrees, sees the changed timestamps, increments `sortEpoch`, recomputes `sortedIds`, and persists again.

## Goals

- Preserve repos from every host when local and runtime catalog requests resolve out of order.
- Make persistence of an already-recorded per-host worktree order a no-op.
- Emit runtime catalog invalidation only when persistence changes the effective order.
- Use the same idempotent persistence behavior for local IPC and runtime RPC callers.
- Keep the runtime protocol compatible: `worktree.persistSortOrder` continues returning `{ updated: number }`, with `0` meaning no change.
- Add tests that use synthetic identifiers and contain no private incident data.

## Non-goals

- Redesign Smart ordering, its attention classes, or its three-second settle window.
- Change runtime pairing, transport, heartbeat, or reconnect behavior.
- Add UI state, preferences, telemetry, dependencies, or platform-specific branches.
- Rework project grouping or host-header presentation.
- Duplicate the latest-state repo merge already present on `main`.

## Constraints

- The behavior must remain portable across macOS, Linux, and Windows and must work when the owner host is reached over the runtime transport.
- No change may add a max-lines suppression or grow a grandfathered file without compensating extraction.
- `WorktreeList.tsx` remains unchanged; it is already grandfathered by the max-lines ratchet.
- Existing runtime error behavior remains unchanged: an unavailable store still raises `runtime_unavailable`, and malformed RPC input remains rejected by the existing schema.
- The public issue, tests, commit, and PR must omit network addresses, usernames, hostnames, local paths, runtime/device IDs, and repository names from the observed environment.
- The owner runtime performs the remote metadata write. Dual-host validation and release notes must make clear that updating only the client does not stop the loop against an older runtime; both test hosts must run a build containing the fix.

## Design

### Shared idempotent persistence

Create `src/main/worktree-sort-order-persistence.ts` with a small store-facing function:

```ts
type WorktreeSortOrderStore = {
  getWorktreeMeta(worktreeId: string): { sortOrder: number } | undefined
  setWorktreeMeta(worktreeId: string, meta: { sortOrder: number }): unknown
}

export function persistWorktreeSortOrderIfChanged(
  store: WorktreeSortOrderStore,
  orderedIds: readonly string[],
  now: number = Date.now()
): { updated: number }
```

The requested order is already persisted when every requested worktree has a finite `sortOrder` and those values are strictly descending in `orderedIds` order. Strict descent matters: equal or missing values cannot reliably restore the requested order after restart.

Strict descent is the complete idempotency contract; existing values do not need to be exactly 1000 milliseconds apart. A one-item request with any finite `sortOrder` is already persisted. Empty input returns `{ updated: 0 }`. Missing, non-finite, tied, or non-descending values force a full rewrite of the requested IDs.

When the order is already persisted, the function returns `{ updated: 0 }` without calling `setWorktreeMeta`. Otherwise it assigns `now - index * 1000` to every requested ID and returns the number written. Comparing relative order instead of exact timestamps makes repeated calls idempotent while preserving the existing cold-start ordering representation.

The function intentionally evaluates only the IDs in the request. Hidden, archived, or other-host worktrees are outside that host-specific ordering request and must not force a rewrite. The production caller supplies unique IDs; duplicate-ID validation is outside this change, so duplicate requests retain the existing rewrite behavior rather than gaining new protocol semantics.

### Local IPC integration

Replace the timestamp loop in `worktrees:persistSortOrder` with the shared function. The handler keeps its existing empty-input guard and `void` return behavior; it must not change the preload contract merely to match the runtime RPC result. Local persistence does not emit a catalog event today, and this design does not add one; it only avoids redundant metadata writes.

### Runtime RPC integration

Replace `OrcaRuntimeService.persistManagedWorktreeSortOrder`'s timestamp loop with the shared function. When `updated === 0`, return immediately without invalidating the resolved-worktree cache or calling `notifyReposChanged()`. When `updated > 0`, retain the current cache invalidation and notification behavior exactly once.

Unlike the local IPC handler, the runtime method currently reaches cache invalidation and notification for an empty array. The shared function's `{ updated: 0 }` result must make that path an explicit no-op, and a runtime-level test must cover it.

This terminates the feedback loop after at most one confirming no-op request:

1. A changed order is persisted and emits `reposChanged`.
2. The client refreshes and recomputes the same effective order.
3. The follow-up persistence call returns `updated: 0` and emits no event.
4. No further refresh is scheduled by this path.

### Repo catalog regression coverage

Add a store-level test that starts a deferred local `fetchRepos()`, completes `fetchRuntimeEnvironmentRepos()` first, and then completes the older local request. The final state must contain both local and runtime repos with their correct execution-host ownership.

The test guards the latest-state merge already present on `main`. It should fail against the v1.4.135 implementation and pass without additional production changes to the repo slice.

## Error Handling and Compatibility

- Store absence continues to throw before persistence is attempted.
- A no-op is a successful RPC response, not an error or timeout.
- The response schema is unchanged; clients that only inspect `updated` remain compatible.
- A real reorder still rewrites the complete requested host order, invalidates the runtime cache, and notifies connected clients.
- Failed RPCs are not hidden or memoized in the renderer because no renderer-side deduplication state is introduced.

## Testing

### Required red-green coverage

- Runtime persistence writes and notifies for the first effective order.
- Repeating the same effective order returns `updated: 0`, performs no writes, and emits no second notification.
- Reordering the same IDs writes again and emits one new notification.
- Missing or tied stored order values are rewritten because they do not encode a stable requested order.
- An empty runtime request returns `updated: 0` without cache invalidation or notification, while the local IPC handler remains `void` and keeps its existing early return.

The repeated-order runtime test must fail against the pre-change implementation before production code is modified.

### Required regression coverage

- A late local repo fetch cannot remove a runtime repo that completed first.
- Existing runtime RPC dispatch coverage continues to return the runtime method result.
- Existing scheduler, runtime-client-event, host-section, repo, and worktree tests remain green.

### Repository checks

- Focused Vitest tests for the new module, runtime method, repo race, RPC dispatch, scheduler, and host-section behavior.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm check:max-lines-ratchet`
- `git diff --check`
- A sanitized dual-host smoke test with both client and owner runtime running a build containing the change; if no installable build is produced locally, record that limitation in the PR.

All Node-based checks must run with the repository-required Node 24 toolchain.

## Alternatives Considered

### Renderer-side last-order tracking

Remembering the last request in `WorktreeList` would avoid calls to older servers, but it needs explicit pending, failure, retry, and remount semantics. It also adds state around an already oversized component. Server-side idempotency is smaller and protects every RPC caller.

### Remove `notifyReposChanged()` unconditionally

This would stop the loop but would prevent other connected clients from learning about a real order change. Conditional notification preserves the existing synchronization contract.

### Exact timestamp comparison

Exact timestamps are regenerated on every write and therefore cannot establish idempotency. The persisted contract is relative order, so relative monotonicity is the correct comparison.

## Delivery

- One implementation PR from `bbingz/fix-8272-remote-host-refresh-loop` to `stablyai/orca:main`.
- The PR body uses `Fixes #8272` and contains only sanitized reproduction evidence.
- Commits remain scoped to the design/specification, tests, shared persistence behavior, and necessary call-site integration.
