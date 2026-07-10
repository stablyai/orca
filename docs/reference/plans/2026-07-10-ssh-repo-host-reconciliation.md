# SSH Repo Host Reconciliation Design

Date: 2026-07-10

## Problem

The proven flow is **Settings -> SSH -> remove host -> re-add the same host**. Main matches the
removal tombstone and `Store.reassignSshTargetId` moves the persisted repo from the old target ID to
the new target ID without changing `Repo.id`. A renderer catalog merge can then retain the cached
old-target row alongside the fetched new-target row because repo rows are keyed by execution host
and repo ID.

The stale row can route a terminal or destructive action to a removed SSH target. PR #7997 made
worktree deletion host-scoped and fail closed; this follow-up removes the superseded renderer row
without weakening that boundary.

## Why UUID Inference Is Unsafe

The same `Repo.id` can legitimately exist on multiple hosts. For example, a local checkout and a
checkout on an SSH server can share the repository UUID. Removing the SSH host without re-adding it
must keep the SSH ghost visible so the user can forget it. A local or runtime row with the same UUID
does not prove that the SSH row moved.

Main already has exact migration evidence. `readoptOrphanedWorkspacesForTarget` selects a removed
target tombstone, and `Store.reassignSshTargetId` knows which repo IDs it moved from that old target
to the new target. The renderer must consume this evidence instead of inferring migration from live
siblings or SSH target metadata.

## Ordering Gap

Main sends `repos:changed` before `ssh:addTarget` or `ssh:importConfig` returns. Either order is
possible in renderer state:

1. The catalog transaction can merge old and new rows before the add response supplies migration
   evidence.
2. The add response can supply evidence while renderer state still contains only the old row.

Evidence must therefore remain pending until the corresponding new direct-SSH row arrives. At that
point the renderer removes only the mapped `(repoId, oldTargetId)` row and its old host setup, and
moves cached worktree ownership onto the new host.

## Non-Goals

- Do not re-key repo or worktree UUIDs or introduce compound serialized IDs.
- Do not infer host migration from labels, paths, target-list absence, or same-UUID siblings.
- Do not remove PR #7997's execution-host context from destructive operations.
- Do not change git-provider behavior or add provider-specific assumptions.

## Design

1. `Store.reassignSshTargetId` returns the exact repo IDs it moved instead of only a count.
2. Main records a list of `{ oldTargetId, newTargetId, repoIds }` for each add/import operation.
3. The SSH IPC add and import results return the changed targets plus this migration evidence. Main
   still sends `repos:changed` when at least one repo moved.
4. Both desktop SSH management surfaces record the evidence in the repo slice immediately after the
   invoke resolves. The web preload returns an empty evidence list because target management is
   desktop-only.
5. The repo slice merges duplicate evidence and keeps unresolved repo IDs pending. Every local,
   targeted-runtime, and all-host catalog transaction reconciles against the latest pending set.
6. Reconciliation requires the exact new direct-SSH owner to exist before pruning the exact old
   direct-SSH owner. Local rows, runtime-owned rows, unrelated SSH hosts, and same-UUID siblings are
   not considered evidence.
7. When a repo row is pruned, its matching `ProjectHostSetup` is removed. The desktop catalog owns
   local and direct-SSH setups; `runtime:<environmentId>` setups remain authoritative on the remote
   Orca server.
8. Cached visible and detected worktree rows for the migrated repo are moved from the exact old SSH
   host to the new host. If a new-host worktree row already arrived, it wins and the stale duplicate
   is discarded.
9. A host-scoped worktree response is ignored if its captured repo/host owner no longer exists.
   Repo catalog transactions also reapply pending worktree migration, covering responses that land
   after evidence arrives but before the new repo row.

```text
main: remove target -> tombstone
main: re-add matching identity -> reassign old target ID to new target ID
main: return exact (old target, new target, moved repo IDs)
renderer: retain evidence until catalog includes the exact new SSH owner
renderer: remove only the exact old SSH row/setup and migrate cached worktree ownership
```

## Safety Constraints

- A local or runtime sibling with the same UUID never supersedes an SSH ghost.
- A mapping is not consumed until the exact new direct-SSH row exists.
- Runtime-owned SSH rows and `runtime:<environmentId>` setup rows remain untouched.
- Catalog transactions reconcile inside the Zustand updater so overlapping responses use the latest
  repos and pending evidence.
- Missing, offline, or unhydrated target metadata is not deletion or migration evidence.

## Test Plan

- Persistence returns exact migrated repo IDs and leaves other hosts untouched.
- Tombstone re-adoption returns exact old/new/repo mappings for manual add and multi-host import.
- SSH IPC returns the evidence, sends `repos:changed`, and clears operation-local evidence.
- Pure renderer tests prove exact pruning, pending evidence, unrelated-host preservation, runtime
  ownership preservation, and evidence deduplication.
- Store tests cover both event orders: catalog first and evidence first.
- Remove-without-re-add keeps a forgettable SSH row and setup when a local repo shares its UUID.
- Old direct-SSH setups are removed only for proven migrations; runtime setups remain.
- Old/new cached worktree duplicates collapse to the authoritative new-host row, and an old-only
  worktree row migrates to the exact new host.
- A deferred old-host worktree response cannot restore old visible or detected ownership after the
  new repo catalog consumes the migration evidence.
- Targeted runtime and all-host catalog transactions reconcile against the latest state.

Run focused tests, typecheck, lint, `pnpm check:max-lines-ratchet`, and the production build required
by the repository.

## Electron Validation

Use an isolated profile and a throwaway Linux SSH target:

1. Add a repo through the throwaway SSH target.
2. Remove the SSH target and re-add the same identity without restarting the renderer.
3. Confirm exactly one SSH project row remains and its worktree opens.
4. Confirm Explorer lists the remote files without an ambiguous-host routing error.
5. Repeat the cycle and confirm the stale row does not return.
6. Keep an adjacent local project visible and confirm it remains unchanged.

There is no new control or copy. The behavioral evidence is the stable row, successful workspace
routing, and deterministic store assertions.

## Performance And Scope

Renderer reconciliation indexes direct SSH repo owners once, then processes each migrated repo ID
once. Setup cleanup is linear in current repos and setups. The change adds no polling, listeners,
subprocesses, or persistent renderer state. IPC payload growth is bounded by the repo IDs actually
migrated during the user-triggered add/import operation.

Windows and POSIX paths do not participate in reconciliation. SSH identity matching remains the
existing strict alias or host/user/port logic, and git-provider identity is not used.
