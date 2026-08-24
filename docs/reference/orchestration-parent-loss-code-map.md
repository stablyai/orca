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
| Public CLI                           | `src/cli/specs/orchestration-parent-loss-specs.ts` and the `parent-checkpoint` / `parent-rebind` handlers in `src/cli/handlers/orchestration.ts`                                                                                       |
| Renderer merge/equality              | `src/renderer/src/store/slices/agent-status.ts`, `src/renderer/src/components/sidebar/worktree-agent-rows.ts`                                                                                                                        |
| Visible degraded UX                  | `src/renderer/src/components/dashboard/DashboardAgentRow.tsx`                                                                                                                                                                        |
| Contract tests                       | `src/shared/orchestration-parent-loss.test.ts`, `src/main/runtime/orca-runtime.test.ts`, `src/main/runtime/rpc/methods/orchestration-parent-loss-freeze.test.ts`, `src/renderer/src/components/dashboard/DashboardAgentRow.test.tsx` |

Data flow: orchestration DB task/run/dispatch -> runtime live-PTY query -> shared context projection ->
renderer store merge -> dashboard degraded-state surface. The runtime is the observer; the renderer
does not infer parent loss from titles. Mutation handlers ask the runtime guard before effects; read
handlers do not. C2 flows from frozen runtime evidence -> durable checkpoint -> explicit approval ->
exact-live-local-parent validation -> bounded single-writer transaction -> old Dispatch failure ->
Run epoch increment -> new Dispatch/correlation -> rebind receipt. D1 remains separate and
independently revertible.
