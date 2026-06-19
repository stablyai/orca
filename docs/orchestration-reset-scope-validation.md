# Orchestration Reset Scope Validation

## Problem

`orchestration.reset` silently clears all orchestration state when no scope is provided. The RPC schema accepts every scope as optional at [src/main/runtime/rpc/methods/orchestration.ts](/Users/jinwoohong/orca/workspaces/orca/bug-orchestration.reset-wipes-all-orchestration/src/main/runtime/rpc/methods/orchestration.ts:139), and the handler falls through to `db.resetAll()` at [src/main/runtime/rpc/methods/orchestration.ts](/Users/jinwoohong/orca/workspaces/orca/bug-orchestration.reset-wipes-all-orchestration/src/main/runtime/rpc/methods/orchestration.ts:585). Existing reset tests only cover explicit single scopes at [src/main/runtime/rpc/methods/orchestration.test.ts](/Users/jinwoohong/orca/workspaces/orca/bug-orchestration.reset-wipes-all-orchestration/src/main/runtime/rpc/methods/orchestration.test.ts:1024).

## Root Cause

`ResetParams` models `all`, `tasks`, and `messages` as independent optional booleans. The handler then chooses the first truthy scope and treats zero truthy scopes as `all`, so `{}` wipes everything and contradictory inputs such as `{ tasks: true, messages: true }` partially apply the first truthy branch.

## Non-goals

- Redesign orchestration storage or reset semantics.
- Add confirmation prompts to the RPC protocol.
- Change `resetAll`, `resetTasks`, or `resetMessages` database behavior.
- Change unrelated orchestration commands or provider-specific behavior.

## Design

1. Enforce exactly one truthy reset scope at the `ResetParams` schema using `superRefine`.
2. Remove the handler fallthrough to `db.resetAll()` so only validated explicit scopes can mutate state.
3. Preserve the existing CLI no-flag shortcut by having [src/cli/handlers/orchestration.ts](/Users/jinwoohong/orca/workspaces/orca/bug-orchestration.reset-wipes-all-orchestration/src/cli/handlers/orchestration.ts:440) pass `all: true` when no reset scope flag is present. This keeps CLI compatibility explicit while preventing ambiguous direct RPC calls.
4. Let explicit multi-flag CLI invocations reach RPC validation and fail with the shared invalid-argument path. Duplicating scope validation in the CLI is unnecessary because all CLI calls already pass through this RPC method.
5. Add RPC regression tests that seed one message and one task, call invalid reset params, assert rejection, and assert both seeded records remain.
6. Add CLI parser tests that `orca orchestration reset` calls RPC with `all: true`, and that explicit flags are passed through unchanged for RPC validation.

## Data Flow

- CLI no-flag path: `orca orchestration reset` -> CLI handler sends `{ all: true }` -> RPC schema validates -> handler calls `resetAll`.
- CLI explicit-flag path: CLI handler forwards the provided flags -> RPC schema validates exactly one truthy scope -> handler calls one database reset method or rejects before side effects.
- Direct RPC path: caller params -> RPC schema validates exactly one scope -> invalid params fail before handler side effects.

## Edge Cases

- `{}` rejects and leaves messages and tasks unchanged.
- `{ all: false }` rejects and leaves messages and tasks unchanged.
- `{ tasks: true, messages: true }` rejects and leaves messages and tasks unchanged.
- `{ all: true, tasks: true }` rejects and leaves messages and tasks unchanged.
- `{ all: false, tasks: true }` is valid and resets tasks only; false values are not selected scopes.
- Non-boolean values such as `{ all: "true" }` are transformed to `undefined` by `OptionalBoolean` and must reject unless exactly one real boolean `true` is present.
- Explicit `{ all: true }`, `{ tasks: true }`, and `{ messages: true }` continue to work.
- Remote and SSH callers are covered because the validation sits behind the shared RPC method, not local CLI process state.
- Unknown keys do not select a scope. If strict unknown-key rejection is desired, that is a separate RPC schema policy change and should not be bundled into this fix.

## Test Plan

- Unit/RPC: extend `src/main/runtime/rpc/methods/orchestration.test.ts` with invalid reset scope tests covering empty params and multiple scopes with preservation assertions.
- Unit/RPC: keep existing single-scope tests green to prove no regression to valid reset behavior.
- CLI parser: extend `src/cli/index.test.ts` to assert no-flag `orchestration reset` sends `all: true` explicitly.
- CLI parser: assert explicit `--tasks`, `--messages`, and multi-flag invocations are represented faithfully rather than silently normalized by the CLI.
- Type/lint: run `pnpm typecheck`, `pnpm lint`, and targeted Vitest tests for the touched RPC and CLI files.
- Electron/e2e: not required for golden behavior because this is non-UI RPC/CLI validation; Stage 6 should validate via tests and local CLI/RPC behavior instead of app screenshots.

## UI Quality Bar

Not UI-visible.

## Review Screenshots

No user-visible UI states. Screenshot artifacts are not required; the validation notes should state that UI screenshot review was skipped because the changed behavior is headless RPC/CLI behavior.

## Rollout

1. Tighten `ResetParams` validation.
2. Simplify the reset handler to trust validated single-scope params.
3. Make CLI no-flag reset pass `all: true` explicitly.
4. Add RPC regression tests for invalid params preserving state.
5. Add CLI parser coverage for the explicit no-flag shortcut and explicit/multi-flag passthrough.
6. Run targeted tests, typecheck, and lint.

## Lightweight Eng Review

- Scope: Kept to reset RPC validation, CLI argument shaping, and regression tests; no storage or UI changes.
- Architecture/data flow: Validation belongs at the shared RPC boundary so CLI, remote, SSH, and direct runtime callers get the same safety contract. CLI no-flag compatibility remains a CLI concern by passing `all: true`.
- Failure modes covered:
  - Empty reset params cannot mutate state.
  - Contradictory scopes cannot partially apply the first truthy branch.
  - Failed validation happens before any database reset method runs.
  - CLI shorthand cannot rely on a dangerous RPC fallback.
  - CLI multi-flag input fails through the same RPC validation as any other caller.
- Test coverage required:
  - `src/main/runtime/rpc/methods/orchestration.test.ts`: reject empty, false-only, and multi-scope params while preserving seeded message/task state.
  - `src/main/runtime/rpc/methods/orchestration.test.ts`: existing valid single-scope tests continue passing.
  - `src/cli/index.test.ts`: no-flag CLI reset passes `all: true`; explicit flags and multi-flag input remain directly represented.
- Performance/blast radius: No material concern. One tiny schema refinement and branch simplification run only when reset is invoked.
- UI quality bar: Not UI-visible.
- Required review screenshots: None; final validation notes should explain that screenshot capture is skipped for headless RPC/CLI behavior.
- Residual risks: CLI users may still accidentally clear all state with `orca orchestration reset` because the compatibility shortcut remains, but direct RPC callers can no longer do so accidentally and CLI behavior is now explicit in the caller.
- Concurrency/consistency: This change prevents invalid reset requests from entering the mutation path, but it does not make the existing multi-statement reset methods transactional or coordinate concurrent reset/create/send calls across windows. That is acceptable for the issue scope because valid resets are still destructive administrative operations; adding reset serialization would be a separate storage-level change.
