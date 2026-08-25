# Parent-loss code map

| Concern                              | Canonical implementation                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wire projection types                | `src/shared/agent-status-types.ts`                                                                                                                                                                                                   |
| Fail-closed state derivation         | `src/shared/orchestration-parent-loss.ts`                                                                                                                                                                                            |
| Runtime parent and epoch observation | `src/main/runtime/orca-runtime.ts`                                                                                                                                                                                                   |
| Mutation freeze enforcement          | `OrcaRuntimeService.assertOrchestrationMutationAllowed`, called by mutation handlers in `src/main/runtime/rpc/methods/orchestration.ts`                                                                                              |
| Durable checkpoint/rebind store      | `src/main/runtime/orchestration/db/parent-loss/parent-loss-checkpoint-store.ts`                                                                                                                                                      |
| Schema and v29 -> v30 migration      | `create-graph-tables-sql.ts`, `migrate-v13-v29.ts`, `contract-constants.ts`                                                                                                                                                          |
| Checkpoint/rebind RPC                | `orchestration.parentCheckpoint`, `orchestration.parentRebind` in `src/main/runtime/rpc/methods/orchestration.ts`                                                                                                                    |
| Human approval authority             | **GAP / HOLD** — request-provided `approvedBy` and `approvalId` are stored, but no server-owned one-time approval ledger currently binds an authenticated human action to the checkpoint and target pane                              |
| Public CLI                           | `src/cli/specs/orchestration-parent-loss-specs.ts` and the `parent-checkpoint` / `parent-rebind` handlers in `src/cli/handlers/orchestration.ts`                                                                                     |
| Renderer merge/equality              | `src/renderer/src/store/slices/agent-status.ts`, `src/renderer/src/components/sidebar/worktree-agent-rows.ts`                                                                                                                        |
| Visible degraded UX                  | `src/renderer/src/components/dashboard/DashboardAgentRow.tsx`                                                                                                                                                                        |
| Contract tests                       | `src/shared/orchestration-parent-loss.test.ts`, `src/main/runtime/orca-runtime.test.ts`, `src/main/runtime/rpc/methods/orchestration-parent-loss-freeze.test.ts`, `src/renderer/src/components/dashboard/DashboardAgentRow.test.tsx` |

Data flow: orchestration DB task/run/dispatch -> runtime live-PTY query -> shared context projection ->
renderer store merge -> dashboard degraded-state surface. The runtime is the observer; the renderer
does not infer parent loss from titles. Mutation handlers ask the runtime guard before effects; read
handlers do not. C2 flows from frozen runtime evidence -> durable checkpoint -> explicit approval ->
exact-live-local-parent validation -> non-legacy Run update -> bounded single-writer transaction -> old Dispatch failure ->
Run epoch increment -> new Dispatch/correlation -> rebind receipt. D1 remains separate and
independently revertible.

## D1 cross-plane verification

| Concern                                                                 | Canonical implementation                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Shared evidence/verdict contract                                        | `src/shared/orchestration-ack-contract.ts`                                          |
| Stored message, thread, sequence, epoch, and native Dispatch query-back | `orchestration.crossPlaneVerify` in `src/main/runtime/rpc/methods/orchestration.ts` |
| Public query command                                                    | `src/cli/specs/orchestration-ack-specs.ts`, `orchestration ack-verify` handler      |
| Contract and runtime evidence tests                                     | `src/main/runtime/orchestration/orchestration-cross-plane-ack-contract.test.ts`     |

The neutral coordinator supplies the identity-link evidence; Orca independently queries its native
message and Dispatch records. The external control-plane name must be non-empty. Neither side's
logical identity is rewritten to the other.

## Revisions after upstream rebase

| Slice                          | Revision          | State                                      |
| ------------------------------ | ----------------- | ------------------------------------------ |
| A1 bootstrap diagnostics       | PR #16349 / `8e94204039` | `VERIFIED_IMPLEMENTED / UPSTREAM_UNLANDED` |
| B1 canonical self-send guard   | PR #16349 / `8e94204039` | `VERIFIED_IMPLEMENTED / UPSTREAM_UNLANDED` |
| A2 profile-routing diagnostics | PR #16349 / `8e94204039` | `VERIFIED_IMPLEMENTED / UPSTREAM_UNLANDED` |
| C1 parent-loss observation     | PR #16349 / `8e94204039` | `VERIFIED_IMPLEMENTED / UPSTREAM_UNLANDED` |
| C2 checkpoint/rebind mechanics | PR #16349 / current branch | `CONDITIONALLY_VERIFIED / APPROVAL_AUTHORITY_HOLD` |
| D1 cross-plane verification    | PR #16349 / current branch | `VERIFIED_IMPLEMENTED / UPSTREAM_UNLANDED` |
