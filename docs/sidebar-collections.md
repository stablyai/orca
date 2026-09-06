# Sidebar Collections

## Problem

Real work is organized by workstream, and a workstream usually spans several repos — but only some branches in each. The sidebar previously offered two ways to model that, and both fall short:

- Project groups operate at the repo level: putting `api` in a "Billing" group shows all of api's worktrees there, including ones that belong to other workstreams.
- A second checkout per workstream works visually but drifts: branches and stashes get stranded in the wrong clone, and each copy costs gigabytes plus a duplicate `.env`.

The missing grouping axis is the **worktree**.

## Behavior

A `Collection` is a named, manual, purely visual sidebar section that holds worktrees across repos, rendered between the Pinned section and the project list in **every** grouping mode (collections are orthogonal to Group by, like Pinned — not a fifth segment):

```text
▾ Approve PRs                ← collection
    analytics
        tech-6481-route-skills
    api                      ← ONE checkout, one folder, one .env
        ptal-age-only
▾ Billing migration
    api                      ← the same repo again…
        billing-schema-v2    ← …showing only its billing worktrees
```

- A collected worktree **also** renders in its normal repo section below — collections are additive; nothing becomes unreachable by filing it.
- Collection headers collapse (persisted via the existing `collapsedGroups` mechanism, keys namespaced `collection:<id>` / `collection:<id>:repo:<repoId>`), carry an optional color tint, and expose a `…` menu: Add worktrees…, Rename, Delete (confirm dialog; worktrees on disk are never touched).
- Entry points: the toolbar layers icon opens the Add Collection modal (every project listed; "+ New worktree" per repo creates a real worktree pre-filed into the collection; existing worktrees pickable); the worktree context menu offers Add to / Move to / Remove from Collection and New Collection…; drag-and-drop onto a collection header (or repo sub-header inside it) files the dragged worktree.
- Rows inside a collection never arm the reorder drag, so manual project-list ordering cannot be corrupted from a collection section.

## Membership invariants

- Membership lives on the worktree: `Worktree.collectionIds?: string[]` (mirrored on `WorktreeMeta`). Canonical form is a deduped array or an **absent key** — `[]` is never persisted, so pre-collection data files stay byte-identical.
- A **feature** worktree lives in exactly one collection. This is a data invariant, not just UX: gestures use `assignCollectionMembership({ exclusive: true })`, and the runtime RPC boundary (`updateManagedWorktreeMeta`) applies `clampExclusiveCollectionMembership` — last id wins — so CLI/web/automation callers cannot multi-file either. `[]` still blanks membership.
- **Main/primary** worktrees may sit in many collections (shared infrastructure).
- Dangling ids are pruned at the `setWorktreeMeta` chokepoint, on load, and when a collection is deleted (delete also prunes the collection's persisted collapse keys).

## Architecture

- `src/shared/collections.ts` — pure, dependency-free helpers (create/normalize/sort/membership/clamp/prune); safe under the CLI's Node16/CJS compile of `src/shared/**`.
- `src/shared/types.ts` — `Collection { id, name, color, isCollapsed, order, createdAt, updatedAt }`, `collectionIds` on `Worktree`/`WorktreeMeta`, `PersistedState.collections`.
- `src/main/persistence.ts` — Store CRUD plus the membership normalization chokepoint in `setWorktreeMeta`.
- `src/main/ipc/worktree-metadata-merge.ts` — one line threads `collectionIds` through the strict merge allowlist; this is what makes membership visible to the renderer, paired clients, and `orca worktree show --json` (zero CLI changes).
- Transport mirrors ProjectGroups: `src/main/ipc/collections.ts` (desktop IPC + preload `window.api.collections`), `collection.list/create/update/delete` runtime RPC methods, `worktree.set` accepts `collectionIds`, and `web-preload-api.ts` bridges the web client to the same RPC methods.
- `src/renderer/src/store/slices/repos.ts` — `collections` state with local/remote routing; delete mirrors membership stripping and collapse-key pruning locally.
- `src/renderer/src/components/sidebar/worktree-list-collections.ts` — pure row builder; output is inserted after the Pinned section via `insertCollectionRowsAfterPinned`. Row keys are namespaced because the same worktree legitimately renders in several places.
- `WorktreeList.tsx` — header rendering (chevron, tinted icon, count, `…` menu, `aria-expanded`, `data-collection-header-id`), drop targets via `data-collection-drop-id`, reorder guards via `isCollectionSectionKey`.
- `AddCollectionDialog.tsx` / `CollectionDeleteDialog.tsx` / `SidebarHeader.tsx` / `WorktreeContextMenu.tsx` — creation and management UX.

## Remote and CLI

Paired web/remote clients get full read/write parity through the runtime RPC methods. Known limitation: collection mutations do not yet push live to paired clients — a refresh picks them up. `orca worktree show --json` includes `collectionIds` with no CLI changes.

## Out of scope (first cut)

Folder workspaces, mobile, per-collection worktree ordering, collection reordering UI (`order` exists on the entity; creation appends), a color picker (color is persisted and rendered), collection-scoped filters, and CLI mutation commands.

## Tests

`src/shared/collections.test.ts` (model + invariants), `src/main/collection-persistence.test.ts` (CRUD, reload, prune, merge threading), `worktree-list-collections.test.ts` (row/header-key contract), `repos-collections.test.ts` (store delete semantics + null-result guard), `web-preload-api.test.ts` (web bridge), and `tests/e2e/collections.spec.ts` (Electron lifecycle: create via toolbar and menu, exclusive move, main multi-membership, collapse, rename, delete leaves `git worktree list` unchanged, CLI parity).
