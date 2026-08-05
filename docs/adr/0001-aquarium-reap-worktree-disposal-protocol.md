---
title: Document aquarium-reap terminology and worktree disposal protocol
type: reference
status: active
tags: [aquarium, reap, worktree-lifecycle, terminology]
updated: 2026-08-05
---

# ADR-001: Aquarium Reap — Worktree Disposal Protocol & Terminology

## Status

Accepted 2026-08-05

## Context

Orca's worktree lifecycle has no unified disposal path. Ghost worktrees (gitdir pointing to missing dir, surfaced as `prunable <reason>` in `git worktree list`) accumulate silently. The existing `removeWorktree` at `src/main/git/worktree.ts` is used internally for rollback, but has no server-side deny gates for ownership or active locks. Issue [#11342](https://github.com/stablyai/orca/issues/11342) documents 191 clustered issues across lifecycle families.

## Decision

Introduce `aquarium:reap` as the single, gated disposal IPC channel for worktrees. The renderer invokes `window.api.aquarium.reap()` which routes to `reapAquariumWorktrees()` in the main process.

## Terminology

| Term | Meaning | Orca source |
|---|---|---|
| **Reap** | Server-side disposal of a worktree + its git admin stub | `aquarium:reap` IPC channel, `reapAquariumWorktrees()` |
| **Ghost** | A worktree whose gitdir points to a non-existent location (`prunable` marker in `git worktree list --porcelain`) | `parseWorktreeList()` `isPrunable` flag |
| **Snapshot** | Pre-disposal state bundle (terminal + agent + session metadata) written to `~/.orca/aquarium/<id>.json` | `snapshot-schema.mjs` spike |
| **Deny gate** | Server-side refusal reason (never trusted from client) | `AquariumReapDenyReason` type |
| **Aquarium** | The idle-state quality loop that consumes reaper output on `tui-idle` triggers | `AquariumPanel.tsx` |

## Deny Gates (server-side only)

1. **guard-block** — `activeLockState` via O_EXCL lock (bookbag `acquire_lock()` parity)
2. **owner-uid** — `isOwnedByLocal()` check (process owner must match worktree owner)
3. **not-found** — worktree not in `git worktree list` output

## Disposal Sequence

```text
For each worktree path:
  git worktree remove --force <path>   # evaporates the working tree
After all removals:
  git worktree prune                   # drops orphaned .git/worktrees/<name>
```

Single prune sweep after the loop prevents a prior removal's prune from stripping the next worktree's admin stub before its own removal runs.

## Consequences

- Client-side deny gates in `AquariumPanel.tsx` are **UX only** — the server re-derives ownership and guard state
- `window.api.aquarium.reap` is the **only** renderer→IPC path for worktree disposal (no other code path invokes `git worktree remove`)
- The original `AquariumPanel.tsx` had no working reap IPC (clicking Reap was a dry-run UI-only operation) — this ADR documents the fix