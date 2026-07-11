# Remote Host Refresh Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve cross-host repo rows during overlapping refreshes and stop unchanged Smart-order persistence from generating a remote `reposChanged` feedback loop.

**Architecture:** Keep the renderer and protocol unchanged. Add one main-process domain module that recognizes a finite, strictly descending persisted order and writes timestamps only when the effective request order differs; route local IPC and runtime RPC persistence through it, and condition runtime cache invalidation/notification on `updated > 0`. Guard the latest-state repo merge already on `main` with an explicit local-versus-runtime overlap test.

**Tech Stack:** TypeScript, Electron main process, Zustand store tests, Vitest, pnpm 10.24.0, Node 24.

## Global Constraints

- Run every Node-based command with the repository-required Node 24 toolchain.
- Do not modify `WorktreeList.tsx`, Smart ordering classes, pairing, heartbeat, transport, UI preferences, or protocol schemas.
- Keep local `worktrees:persistSortOrder` return behavior `void`; keep runtime `worktree.persistSortOrder` returning `{ updated: number }`.
- Do not add max-lines suppressions or increase baseline entries.
- Keep all identifiers synthetic and omit incident IPs, usernames, hostnames, paths, runtime/device IDs, and repository names.
- The owner runtime performs remote writes; PR validation must state that both test hosts need a build containing the fix.
- Preserve unrelated worktree state and do not touch the original checkout's `HANDOFF.md` or `mobile/build/`.

---

### Task 1: Lock the cross-host repo race regression

**Files:**
- Modify: `src/renderer/src/store/slices/repos-stale-fetch.test.ts`

**Interfaces:**
- Consumes: `fetchRepos(): Promise<void>` and `fetchRuntimeEnvironmentRepos(environmentId: string): Promise<Repo[]>` from `RepoSlice`.
- Produces: a regression proving both `local` and `runtime:env-1` repo ownership survive when an older local request resolves last.

- [ ] **Step 1: Add the overlap regression**

Add this test to the focused stale-fetch suite. Extend its `window.api` fixture with the minimal compatible `runtimeEnvironments.call` responses needed by `fetchRuntimeEnvironmentRepos`; do not grow the near-limit all-host test file.

```ts
it('preserves a runtime catalog when an older local refresh finishes last', async () => {
  const { promise: localResponse, resolve: resolveLocal } = Promise.withResolvers<Repo[]>()
  reposList.mockReturnValueOnce(localResponse)
  const store = createTestStore()

  const localLoad = store.getState().fetchRepos()
  await store.getState().fetchRuntimeEnvironmentRepos('env-1')
  resolveLocal([localRepo])
  await localLoad

  expect(store.getState().repos).toEqual([
    { ...remoteRepo, executionHostId: 'runtime:env-1' },
    { ...localRepo, executionHostId: 'local' }
  ])
})
```

- [ ] **Step 2: Run the regression on current `main` behavior**

Run:

```bash
pnpm exec vitest run \
  --config config/vitest.config.ts \
  src/renderer/src/store/slices/repos-stale-fetch.test.ts
```

Expected: PASS. This is coverage for the latest-state merge already delivered by `25ecf2eea`; no repo-slice production edit follows.

- [ ] **Step 3: Commit the regression**

```bash
git add src/renderer/src/store/slices/repos-stale-fetch.test.ts
git commit -m "test: cover cross-host repo refresh race"
```

---

### Task 2: Make worktree sort-order persistence idempotent

**Files:**
- Create: `src/main/worktree-sort-order-persistence.ts`
- Create: `src/main/worktree-sort-order-persistence.test.ts`
- Create: `src/main/runtime/orca-runtime-sort-order.test.ts`
- Create: `src/main/ipc/worktrees-sort-order.test.ts`
- Modify: `src/main/runtime/orca-runtime.ts:16283-16297`
- Modify: `src/main/ipc/worktrees.ts:2064-2078`

**Interfaces:**
- Produces: `persistWorktreeSortOrderIfChanged(store, orderedIds, now?): { updated: number }`.
- Consumes: structural store methods `getWorktreeMeta(id)` and `setWorktreeMeta(id, { sortOrder })`.
- Runtime integration: skips cache invalidation and `notifyReposChanged()` when `updated === 0`.
- Local integration: calls the same helper but retains `void` IPC behavior and the existing empty-input guard.
- Test isolation: do not grow grandfathered `orca-runtime.test.ts` or `worktrees.test.ts`; use the focused new files above, and keep both grandfathered production files at or below their base line counts by replacing their existing loops with shorter delegations.

- [ ] **Step 1: Add the runtime feedback-loop RED test**

Create `src/main/runtime/orca-runtime-sort-order.test.ts`. Instantiate `OrcaRuntimeService` with a minimal structural store whose `setWorktreeMeta` updates an in-memory metadata map, subscribe with `onClientEvent`, and spy on the private cache invalidator through a narrow test-only structural cast. Do not attach a renderer notifier; the assertion must observe the remote client-event stream that drives the cross-host refresh.

Add one sequential test with this exact lifecycle:

```ts
expect(runtime.persistManagedWorktreeSortOrder(['first', 'second'])).toEqual({ updated: 2 })
expect(setWorktreeMeta).toHaveBeenCalledTimes(2)
expect(invalidateResolvedWorktreeCache).toHaveBeenCalledTimes(1)
expect(events).toEqual([{ type: 'reposChanged' }])

expect(runtime.persistManagedWorktreeSortOrder(['first', 'second'])).toEqual({ updated: 0 })
expect(setWorktreeMeta).toHaveBeenCalledTimes(2)
expect(invalidateResolvedWorktreeCache).toHaveBeenCalledTimes(1)
expect(events).toEqual([{ type: 'reposChanged' }])

expect(runtime.persistManagedWorktreeSortOrder(['second', 'first'])).toEqual({ updated: 2 })
expect(setWorktreeMeta).toHaveBeenCalledTimes(4)
expect(invalidateResolvedWorktreeCache).toHaveBeenCalledTimes(2)
expect(events).toEqual([{ type: 'reposChanged' }, { type: 'reposChanged' }])
```

Add a separate empty-input test that expects `{ updated: 0 }`, zero metadata writes, zero cache invalidations, and zero remote events.

- [ ] **Step 2: Add the local IPC RED tests without growing the grandfathered suite**

Create `src/main/ipc/worktrees-sort-order.test.ts`. Mock only Electron's `ipcMain.handle`/`removeHandler`, register `registerWorktreeHandlers` with structural `store` and `runtime` stubs, capture the actual `worktrees:persistSortOrder` callback, and assert:

```ts
const result = handler(null, { orderedIds: ['first', 'second'] })
expect(result).toBeUndefined()
expect(store.setWorktreeMeta).not.toHaveBeenCalled()
```

Seed `getWorktreeMeta` with finite descending values. Add a second test for `orderedIds: []` proving the existing early return does not call `getWorktreeMeta` or `setWorktreeMeta` and remains `void`.

- [ ] **Step 3: Run the integration tests RED**

Run:

```bash
pnpm exec vitest run \
  --config config/vitest.config.ts \
  src/main/runtime/orca-runtime-sort-order.test.ts \
  src/main/ipc/worktrees-sort-order.test.ts
```

Expected: FAIL on the repeated runtime request, empty runtime request, and unchanged local request because the existing paths always rewrite and the runtime always invalidates/emits. The first-write, reorder, and local-empty assertions may already pass.

- [ ] **Step 4: Add focused helper RED coverage**

Create `src/main/worktree-sort-order-persistence.test.ts` before the module exists. Cover:

- empty input and a singleton with any finite value return `{ updated: 0 }` without writes;
- multiple finite values that are strictly descending, including non-1000 gaps, return `{ updated: 0 }` without writes;
- missing, tied, non-finite, and non-descending values each rewrite every requested ID;
- unrelated metadata outside `orderedIds` does not affect the decision;
- a rewrite with injected `now = 5000` writes exactly `5000`, then `4000`, and returns the requested count.

Run the test once and confirm it fails because the module is absent. Then create only a compiling throwing stub, rerun, and confirm the assertions still fail for the unimplemented behavior before writing the real implementation.

- [ ] **Step 5: Implement the shared persistence module**

Create `src/main/worktree-sort-order-persistence.ts`:

```ts
type WorktreeSortOrderStore = {
  getWorktreeMeta(worktreeId: string): { sortOrder: number } | undefined
  setWorktreeMeta(worktreeId: string, meta: { sortOrder: number }): unknown
}

function hasPersistedWorktreeSortOrder(
  store: WorktreeSortOrderStore,
  orderedIds: readonly string[]
): boolean {
  let previous = Number.POSITIVE_INFINITY
  for (const id of orderedIds) {
    const current = store.getWorktreeMeta(id)?.sortOrder
    if (typeof current !== 'number' || !Number.isFinite(current) || current >= previous) {
      return false
    }
    previous = current
  }
  return true
}

export function persistWorktreeSortOrderIfChanged(
  store: WorktreeSortOrderStore,
  orderedIds: readonly string[],
  now = Date.now()
): { updated: number } {
  if (orderedIds.length === 0 || hasPersistedWorktreeSortOrder(store, orderedIds)) {
    return { updated: 0 }
  }
  for (let index = 0; index < orderedIds.length; index += 1) {
    store.setWorktreeMeta(orderedIds[index], { sortOrder: now - index * 1000 })
  }
  return { updated: orderedIds.length }
}
```

- [ ] **Step 6: Integrate the runtime method**

Import the helper from `../worktree-sort-order-persistence`, then replace the method body after the store guard with:

```ts
const result = persistWorktreeSortOrderIfChanged(this.store, orderedIds)
if (result.updated === 0) {
  // Why: refreshing unchanged timestamps would feed Smart sort back into this RPC.
  return result
}
this.invalidateResolvedWorktreeCache()
this.notifyReposChanged()
return result
```

The new body plus import must not grow `src/main/runtime/orca-runtime.ts` relative to `origin/main`.

- [ ] **Step 7: Integrate the local IPC handler**

Import the helper from `../worktree-sort-order-persistence`, retain the existing malformed/empty guard, and replace the timestamp loop with:

```ts
persistWorktreeSortOrderIfChanged(store, args.orderedIds)
```

Do not return the helper result from the IPC handler.

The shorter delegation must leave `src/main/ipc/worktrees.ts` at or below its `origin/main` line count.

- [ ] **Step 8: Run GREEN**

Run:

```bash
pnpm exec vitest run \
  --config config/vitest.config.ts \
  src/main/worktree-sort-order-persistence.test.ts \
  src/main/runtime/orca-runtime-sort-order.test.ts \
  src/main/ipc/worktrees-sort-order.test.ts \
  src/main/runtime/rpc/methods/worktree.test.ts
```

Expected: PASS, including first-write/repeat/reorder event sequencing, empty cache/event suppression, local `void` and early-return behavior, helper edge cases, and existing RPC result forwarding.

Also run:

```bash
git diff --numstat origin/main -- \
  src/main/runtime/orca-runtime.ts \
  src/main/ipc/worktrees.ts
```

Expected: for each grandfathered production file, deleted lines are greater than or equal to added lines.

- [ ] **Step 9: Commit the behavior fix**

```bash
git add \
  src/main/worktree-sort-order-persistence.ts \
  src/main/worktree-sort-order-persistence.test.ts \
  src/main/runtime/orca-runtime.ts \
  src/main/runtime/orca-runtime-sort-order.test.ts \
  src/main/ipc/worktrees.ts \
  src/main/ipc/worktrees-sort-order.test.ts
git commit -m "fix: stop remote sort-order refresh loops"
```

---

### Task 3: Verify, review, and publish the fix

**Files:**
- Inspect: all changes from `origin/main...HEAD`
- Update only if review finds a confirmed defect: files named by that finding

**Interfaces:**
- Consumes: commits from Tasks 1 and 2.
- Produces: a clean, source-backed PR linked to issue `#8272`.

- [ ] **Step 1: Run focused behavioral tests**

```bash
pnpm exec vitest run \
  --config config/vitest.config.ts \
  src/renderer/src/store/slices/repos-all-hosts.test.ts \
  src/renderer/src/store/slices/repos-stale-fetch.test.ts \
  src/renderer/src/hooks/runtime-project-refresh-scheduler.test.ts \
  src/renderer/src/hooks/runtime-client-events-sync.test.ts \
  src/renderer/src/components/sidebar/host-section-rows.test.ts \
  src/main/worktree-sort-order-persistence.test.ts \
  src/main/runtime/orca-runtime-sort-order.test.ts \
  src/main/ipc/worktrees-sort-order.test.ts \
  src/main/runtime/orca-runtime.test.ts \
  src/main/runtime/rpc/methods/worktree.test.ts \
  src/main/ipc/worktrees.test.ts
```

Expected: all selected files pass with zero failed tests.

- [ ] **Step 2: Run repository gates**

```bash
pnpm lint
pnpm typecheck
pnpm check:max-lines-ratchet
pnpm build
git diff --check origin/main...HEAD
```

Expected: every command exits `0`; no max-lines baseline entry is added.

- [ ] **Step 3: Inspect scope and privacy**

```bash
git status --short --branch
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- \
  src/main \
  src/renderer/src/store/slices/repos-all-hosts.test.ts \
  docs/superpowers
```

Confirm the diff contains no renderer UI edit, dependency change, protocol schema change, or incident identifier. Record that dual-host installation smoke was not run unless both hosts were explicitly updated to this build.

- [ ] **Step 4: Request an independent code review**

Provide the reviewer with:

```text
Base: origin/main
Head: HEAD
Requirements: docs/superpowers/specs/2026-07-11-remote-host-refresh-loop-design.md
Focus: idempotency correctness, notification/cache semantics, local void contract, cross-host race test, privacy, and max-lines compliance.
```

Fix every confirmed Critical or Important finding, then rerun Steps 1-3.

- [ ] **Step 5: Push and open the linked PR**

Push the branch to the authenticated fork and create a PR into `stablyai/orca:main`. The body must include:

```markdown
## Summary
- preserve runtime repo rows when an older local refresh finishes last
- make local and runtime Smart-order persistence idempotent
- notify remote clients only when the effective order changes

## Testing
- focused Vitest suite
- `pnpm lint`
- `pnpm typecheck`
- `pnpm check:max-lines-ratchet`
- `pnpm build`

## Runtime note
The metadata write occurs on the owner runtime. Both hosts must run a build containing this fix for dual-host validation; a client-only update does not stop the loop against an older runtime.

Fixes #8272
```

After creation, verify the PR base/head branches, issue linkage, CI start, and that no sensitive incident data appears in the public diff or body.
