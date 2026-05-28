# Worktree Delete Preflight

## Problem

- Local delete paths kill PTYs before git deletion:
- `worktrees:remove` IPC (`src/main/ipc/worktrees.ts`)
- `removeManagedWorktree` runtime/RPC (`src/main/runtime/orca-runtime.ts`)
- On non-force failures (dirty/untracked is common), the worktree stays on disk but terminals are already gone.
- PTY teardown is intentionally destructive and best-effort (`src/main/runtime/worktree-teardown.ts`), so non-force deletability must be checked first.

## Ground Truth From Code

- There is no dry-run remove path currently used in git helpers (`src/main/git/worktree.ts`).
- Errors shown to users are normalized through `formatWorktreeRemovalError` (`src/main/ipc/worktree-logic.ts`).
- SSH-backed repos already delegate deletion to provider APIs and should remain provider-owned.
- Current orphan cleanup (`is not a working tree` handling + prune + metadata cleanup) lives in IPC/runtime remove catch blocks and must not regress.

## Non-goals

- Do not change force-delete semantics; force may still kill PTYs before git remove.
- Do not add new renderer confirmation states or copy.
- Do not attempt to predict every possible git remove failure.
- Do not change SSH provider teardown ownership.

## Design

1. Add local preflight helper in `src/main/git/worktree.ts`.
- Export `assertWorktreeCleanForRemoval(worktreePath: string, force = false): Promise<void>`.
- If `force`, return immediately.
- Run `git status --porcelain --untracked-files=all` in `cwd = worktreePath`.
- If output is non-empty, throw a dedicated error (dirty/untracked).
- If command fails, rethrow original error.

2. IPC local delete ordering (`worktrees:remove`).
- Keep canonicalization and protected-path validation first (`getRegisteredDeletableWorktree`).
- Keep SSH provider branch unchanged.
- Keep archive hook and symlink cleanup before preflight, so preflight checks the exact post-hook/post-symlink state that `git worktree remove` will see.
- Run preflight.
- If preflight throws an orphan/missing-worktree style error, continue to existing remove path so current orphan cleanup behavior still executes.
  Treat at least these as orphan-compatible for preflight: `is not a working tree`, `not a git repository`, and missing-path (`ENOENT`) failures from running status in a removed directory.
- For other preflight failures, throw via `formatWorktreeRemovalError(...)`.
- Only after successful preflight: run `killAllProcessesForWorktree(...)`, then `removeWorktree(...)`.

3. Runtime/RPC local delete ordering (`removeManagedWorktree`).
- Keep SSH branch unchanged.
- Keep current hook behavior (archive optional via `--run-hooks`, warning when configured but skipped).
- Run preflight after hook handling.
- Preserve orphan compatibility exactly as in IPC: preflight must not short-circuit existing orphan cleanup semantics (including `not a git repository`/`ENOENT` preflight failures that should fall through to the existing remove/catch path).
- On successful preflight: run PTY teardown, then `removeWorktree`.
- Route failures through existing formatted error surface.

4. Failure-class behavior contract.
- Dirty/untracked (non-force): fail before PTY teardown.
- Preflight subprocess/tooling failures: fail before PTY teardown, formatted.
- Orphan/missing-worktree conditions (`is not a working tree`, `not a git repository`, `ENOENT`): retain current cleanup-and-metadata-removal behavior by running the existing remove/catch flow without PTY teardown.
- Force deletes: no preflight; keep current teardown-before-remove order.

5. Tests.
- Update ordering assertions for non-force local deletes to `preflight -> kill -> git`.
- Add IPC/runtime tests proving dirty non-force failures happen before any PTY kill.
- Add IPC/runtime tests proving preflight error formatting uses `formatWorktreeRemovalError` path.
- Add IPC/runtime regression tests proving orphan cleanup still runs when preflight encounters orphan-like failures.
- Keep force ordering tests (`kill -> git`).
- Keep SSH tests proving local PTY teardown is not used for SSH-backed repos.

## Concurrency, Consistency, Limits

- Preflight narrows, but does not close, the race window: external edits can occur after preflight and before `git worktree remove`.
- Multi-window and out-of-band mutation races remain possible between canonicalization, hooks/symlink cleanup, preflight, kill, and remove.
- IPC has symlink cleanup before preflight; runtime does not. That asymmetry remains unless runtime gains equivalent cleanup.
- Cost is one additional git subprocess per non-force local delete; this is acceptable for a user-initiated destructive action.

## Rollout

1. Implement `assertWorktreeCleanForRemoval` + unit tests in `src/main/git/remove-worktree.test.ts`.
2. Wire IPC ordering and failure mapping in `src/main/ipc/worktrees.ts`; update `src/main/ipc/worktrees.test.ts`.
3. Wire runtime ordering and failure mapping in `src/main/runtime/orca-runtime.ts`; update `src/main/runtime/orca-runtime.test.ts`.
4. Run focused tests, then `pnpm typecheck` and `pnpm lint`.
