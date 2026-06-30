# Pipeline RPC / DB Contract

## Source

- PRD: `docs/prd/orca-sandcastle-like-pipeline.md`
- Architecture: `docs/architecture/orca-pipeline-architecture.md`
- Requirement IDs: R1-R49

## API Contract

| ID      | RPC method               | Request                                          | Response                                   | Error shape                 | Callers                                            |
| ------- | ------------------------ | ------------------------------------------------ | ------------------------------------------ | --------------------------- | -------------------------------------------------- |
| C-RPC-1 | `pipelines.templateList` | none or `{ includeBuiltIn?: boolean }`           | `{ templates: PipelineTemplateSummary[] }` | `{ error: string }`         | CLI, UI                                            |
| C-RPC-2 | `pipelines.run`          | `PipelineRunInput`                               | `{ run: PipelineRun }`                     | `{ error, code, details? }` | CLI, UI, AutomationService                         |
| C-RPC-3 | `pipelines.list`         | `{ repoId?, status?, limit? }`                   | `{ runs: PipelineRunSummary[] }`           | `{ error: string }`         | CLI, UI                                            |
| C-RPC-4 | `pipelines.show`         | `{ runId: string }`                              | `{ run, iterations, tasks, stages, logs, dynamicContextResults }` | `{ error: string }`         | CLI, UI                                            |
| C-RPC-5 | `pipelines.cancel`       | `{ runId: string, preserveWorktrees?: boolean }` | `{ run }`                                  | `{ error: string }`         | CLI, UI, AutomationService                         |
| C-RPC-6 | `pipelines.logs`         | `{ runId: string, stageId?, taskId?, limit? }`   | `{ logs: PipelineLogEntry[] }`             | `{ error: string }`         | CLI, UI                                            |
| C-RPC-7 | `pipelines.releaseStaleReservation` | `{ reservationId: string, confirm: true }` | `{ released: true }`                       | `{ error, code, owningRunId? }` | CLI, UI                                        |
| C-RPC-8 | `pipelines.prdCandidates` | `{ repoId, owner, repo, limit?, since? }` | `{ candidates: PipelinePrdCandidate[] }` | `{ error: string }` | UI |
| C-RPC-9 | `pipelines.recoveryReportList` | `{ repoId?, prdIssueNumber?, status? }` | `{ reports: PipelineRecoveryReport[] }` | `{ error: string }` | CLI, UI |
| C-RPC-10 | `pipelines.recoveryReportAcknowledge` | `{ reportId: string }` | `{ report: PipelineRecoveryReport }` | `{ error: string }` | CLI, UI |

## CLI Contract

| CLI command                    | RPC method               | Required flags or args                                                                                         | Output fields                                         |
| ------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `orca pipelines template-list` | `pipelines.templateList` | none                                                                                                            | `templates[]`                                         |
| `orca pipelines run`           | `pipelines.run`          | `--template`, `--repo`, `--source-branch`, `--target-branch`, `--task-source`, agents, task-source-specific flags | `run`                                                 |
| `orca pipelines list`          | `pipelines.list`         | optional `--repo`, `--status`, `--limit`                                                                        | `runs[]`                                              |
| `orca pipelines show`          | `pipelines.show`         | `--run`                                                                                                         | `run`, `iterations`, `tasks`, `stages`, `logs`, `dynamicContextResults` |
| `orca pipelines cancel`        | `pipelines.cancel`       | `--run`; optional `--preserve-worktrees`                                                                        | `run`                                                 |
| `orca pipelines logs`          | `pipelines.logs`         | `--run`; optional `--stage`, `--task`, `--limit`                                                                | `logs[]`                                             |
| `orca pipelines release-stale-reservation` | `pipelines.releaseStaleReservation` | `--reservation`, `--confirm`                                                                   | `released`                                            |
| `orca pipelines recovery-reports` | `pipelines.recoveryReportList` | optional `--repo`, `--prd-issue`, `--status`                                                     | `reports[]`                                           |
| `orca pipelines recovery-report-acknowledge` | `pipelines.recoveryReportAcknowledge` | `--report`                                                                    | `report`                                              |

## PipelineRunInput

```ts
type PipelineRunInput = {
  templateId: string
  repoId: string
  sourceBranch: string
  targetBranch: string
  taskSource: PipelineTaskSource
  maxConcurrent: number
  maxIterations?: number
  plannerAgentId: TuiAgent
  implementerAgentId: TuiAgent
  reviewerAgentId?: TuiAgent
  mergerAgentId: TuiAgent
  verifier?: {
    commands: string[]
    timeoutSeconds: number
  }
  executionTargetType: 'local' | 'ssh'
  executionTargetId?: string
}
```

If PipelineService has a latest pending recovery report for the same PRD work set after an interrupted run, `pipelines.run` rejects until that report is acknowledged through `pipelines.recoveryReportAcknowledge`.

## PipelineRecoveryReport

```ts
type PipelineRecoveryReport = {
  id: string
  interruptedRunId: string
  replacementRunId?: string
  repoId: string
  owner: string
  repo: string
  prdIssueNumber: number
  pipelinePrdLabel: string
  status: 'pending_ack' | 'acknowledged'
  summary: {
    completedTaskIssueNumbers: number[]
    openReadyTaskIssueNumbers: number[]
    preservedWorktreeIds: string[]
    dirtyWorktreeIds: string[]
    liveTerminalIds: string[]
    missingTerminalIds: string[]
  }
  createdAt: string
  acknowledgedAt?: string
}
```

## PipelinePrdCandidate

```ts
type PipelinePrdCandidate = {
  provider: 'github'
  owner: string
  repo: string
  prdIssueNumber: number
  prdTitle: string
  pipelinePrdLabel: string
  readyTaskCount: number
  openTaskCount: number
  latestTaskUpdatedAt: string
  latestPrdUpdatedAt: string
  activeRunId?: string
  reservationId?: string
}
```

Candidate rules:

- Candidates are derived from recent open GitHub PRD issues, task-slice issues with the exact derived `pipeline:prd-<number>` label whose parent PRD is open, and existing active Pipeline run/reservation records for open PRDs.
- Candidates are grouped by provider repo and PRD issue number. `pipelinePrdLabel` is always derived as `pipeline:prd-<prdIssueNumber>`.
- The default visible section prioritizes candidates with `readyTaskCount > 0`; zero-ready candidates may be shown disabled with the missing readiness reason.
- Closed PRDs are omitted from launch candidates and remain visible only through run history or completion evidence.
- Selecting a candidate fills the run input's PRD issue number and derived Pipeline PRD label, then previews the full PRD ready task set.
- Candidate selection must not add, remove, reorder, narrow individual task issues, or define alternate task groups.

## Automation Target Contract

```ts
type AutomationTarget =
  | { type: 'prompt'; prompt: string }
  | {
      type: 'pipeline'
      pipelineTemplateId: string
      pipelineInput: PipelineRunInput
    }
```

Rules:

- Existing prompt automations read as `{ type: 'prompt', prompt }`.
- Pipeline automations keep the legacy `prompt` field for compatibility, but dispatch from `target.pipelineInput`.
- `AutomationService` creates a Pipeline run directly for `target.type === 'pipeline'`; it does not send `automations:dispatchRequested` to the renderer.
- `AutomationRun.pipelineRunId` stores the created Pipeline run id and is shown in Automation run history.

## Database Contract

| ID     | Table                              | Fields                                                                                                                                                                                                                                                                                                                                                      | Constraints                                                                                                                                                                | Real read/write path                              |
| ------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| C-DB-1 | `pipeline_runs`                    | `id`, `template_id`, `repo_id`, `source_branch`, `target_branch`, `task_source_json`, `status`, `status_reason`, `max_concurrent`, `max_iterations`, `current_iteration`, `planner_agent_id`, `implementer_agent_id`, `reviewer_agent_id`, `merger_agent_id`, `verifier_json`, `execution_target_type`, `execution_target_id`, `automation_run_id`, `replaces_run_id`, `recovery_report_id`, timestamps, `error_json` | `status` in `pending/planning/dispatching/executing/reviewing/merging/verifying/completed/failed/cancelled/interrupted`; terminal statuses are immutable; `status_reason` includes `prd_closed` when parent PRD closure cancels a run; `max_iterations >= 1`; `execution_target_type` in `local/ssh`; `recovery_report_id` is unique when present and points to an acknowledged recovery report for the same PRD work set; `replaces_run_id` points to that report's interrupted run | PipelineService creates and updates; UI/CLI reads |
| C-DB-2 | `pipeline_iterations`              | `id`, `run_id`, `iteration_number`, `status`, `planner_terminal_id`, `planner_worktree_id`, `coordinator_run_id`, `planner_output_json`, timestamps, `error_json`                                                                                                                                                                                           | unique `(run_id, iteration_number)`                                                                                                                                        | PipelineService owns                              |
| C-DB-3 | `pipeline_tasks`                   | `id`, `run_id`, `iteration_id`, `source_type`, `source_id`, `title`, `branch`, `status`, `blocked_by_json`, `orchestration_task_id`, `worktree_id`, `terminal_ids_json`, `commit_shas_json`, `result_json`, `issue_closure_json`, timestamps, `error_json`                                                                                                   | unique `(run_id, source_type, source_id, iteration_id)`; branch deterministic                                                                                              | PipelineService creates from planner output       |
| C-DB-4 | `pipeline_stages`                  | `id`, `run_id`, `iteration_id`, `task_id`, `stage`, `status`, `worktree_id`, `terminal_id`, `started_at`, `completed_at`, `output_snapshot`, `error_json`                                                                                                                                                                                                   | `stage` in `task_source/planner/implement/review/merge/verify`; status has terminal states                                                                                 | PipelineService owns                              |
| C-DB-5 | `pipeline_logs`                    | `id`, `run_id`, `iteration_id`, `task_id`, `stage_id`, `level`, `message`, `payload_json`, `created_at`                                                                                                                                                                                                                                                     | append-only                                                                                                                                                                | PipelineService and runners append                |
| C-DB-6 | `pipeline_dynamic_context_results` | `id`, `run_id`, `stage_id`, `template_id`, `command`, `cwd`, `exit_code`, `timed_out`, `stdout`, `stderr`, truncation flags, timestamps                                                                                                                                                                                                                     | command must match raw template dynamic context block                                                                                                                      | Prompt renderer writes                            |
| C-DB-7 | `pipeline_active_run_reservations` | `id`, `run_id`, `repo_id`, `provider_owner`, `provider_repo`, `pipeline_prd_label`, `prd_issue_number`, `status`, `created_at`, `released_at`, `release_reason`, `last_seen_at`                                                                                                                               | unique active reservation for `(repo_id, provider_owner, provider_repo, prd_issue_number, pipeline_prd_label)` inside the same Orca runtime                   | PipelineService preflight creates/releases        |
| C-DB-8 | `pipeline_recovery_reports` | `id`, `interrupted_run_id`, `repo_id`, `provider_owner`, `provider_repo`, `prd_issue_number`, `pipeline_prd_label`, `status`, `summary_json`, `created_at`, `acknowledged_at` | unique pending report for `(repo_id, provider_owner, provider_repo, prd_issue_number, pipeline_prd_label, interrupted_run_id)`; `status` in `pending_ack/acknowledged`; every interrupted run, including a replacement run, may have its own recovery report; if multiple pending reports exist for one PRD work set, latest means newest `created_at`, then newest id as tie-breaker | PipelineService startup writes; UI/CLI reads; run preflight blocks on latest pending only; acknowledgement RPC acknowledges; replacement run links back through `pipeline_runs.recovery_report_id` |

## Generic Orchestration Extension

Add generic task execution metadata, not Pipeline-specific metadata.

```ts
type OrchestrationTaskExecutionContext = {
  worktreeSelector?: string
  preferredTerminalHandle?: string
  title?: string
}
```

DB option:

- Add `execution_context_json TEXT` to `tasks`.
- `orchestration.taskCreate` accepts optional `executionContext`.
- Coordinator uses `executionContext.worktreeSelector` when listing or creating worker terminals for that task.

Why: Pipeline needs per-task worktrees, but Orchestration should remain a reusable DAG dispatcher.

## Business Rules

| ID      | Condition                                           | Behavior                                                                                                                    | Enforced in                    | Test               |
| ------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------ |
| C-BR-1  | User launches with zero PRD ready tasks             | Reject before creating a new run; show the empty preview and required labels.                                               | PipelineService preflight      | Unit + integration |
| C-BR-2  | Planner omits `<plan>`                              | Iteration fails with raw output summary and planner terminal link.                                                          | Structured output parser       | Unit               |
| C-BR-3  | Planner returns invalid JSON or schema              | Iteration fails before worktrees or tasks are created.                                                                      | Structured output parser       | Unit               |
| C-BR-4  | Planned task has branch collision in same iteration | Planning fails unless the collision maps to the same source task.                                                           | PipelineService                | Unit               |
| C-BR-5  | Pipeline Task has blockers                          | Orchestration task deps map to blocking task IDs when blockers are in the same iteration; otherwise task is not dispatched. | OrchestrationBridge            | Integration        |
| C-BR-6  | Implementer completes without commits               | Skip review and merge for that task; mark task `no_changes`.                                                                | PipelineService git inspection | Integration        |
| C-BR-7  | Implementer fails or escalates                      | Mark task failed; coordinator may retry within circuit-breaker rules; Pipeline records final failure.                       | Coordinator + PipelineService  | Integration        |
| C-BR-8  | Reviewer produces commits                           | Merge both implement and review commits.                                                                                    | PipelineService git inspection | Integration        |
| C-BR-9  | Merge conflict cannot be resolved                   | Iteration fails; merge worktree is preserved.                                                                               | Merge runner                   | Live               |
| C-BR-10 | Verify command fails                                | Run fails after merge; preserve merge worktree and command logs.                                                            | Verify runner                  | Integration        |
| C-BR-11 | Max iterations reached while work remains           | Run stops with `completed_with_remaining_work` or `failed_limit_reached` per template policy.                               | PipelineService                | Integration        |
| C-BR-12 | User cancels run                                    | Stop planner/coordinator/stage terminals where possible; mark incomplete stages cancelled; preserve worktrees by default.   | PipelineService                | Integration        |
| C-BR-13 | GitHub task source omits PRD issue or exact derived Pipeline PRD label | Reject the run before listing or planning tasks.                                                                            | PipelineService validation     | Unit               |
| C-BR-14 | Selected task issue does not reference the PRD issue | Reject the run before planner launch; do not create task worktrees.                                                        | TaskSource adapter             | Integration        |
| C-BR-15 | UI tries to narrow or reorder PRD ready tasks        | Reject the run input; UI may preview the task set but cannot select or sort individual tasks.                              | PipelineService validation     | Unit               |
| C-BR-16 | Run input includes individual issue-number selection | Reject the run input; UI, CLI, and RPC must use the full PRD ready task set.                                               | PipelineService validation     | Unit               |
| C-BR-17 | Later iteration finds zero ready tasks              | Complete the existing run cleanly; this means no more work is available for that run.                                      | PipelineService loop           | Integration        |
| C-BR-18 | Active run already owns the same PRD work set reservation | Reject the new run before planner launch and return the active run id for UI/CLI linking, even when the new launch selects a different local/SSH execution target. | PipelineService preflight      | Integration        |
| C-BR-19 | Run reaches completed/failed/cancelled/interrupted   | Release its active run reservation in the same final-state transaction.                                                    | PipelineService                | Unit + integration |
| C-BR-20 | Restart finds an active non-terminal reservation whose terminal/coordinator/stage processes are still alive | Reconnect monitoring, preserve the reservation, and show the owning run; do not create a replacement run. | PipelineService startup | Integration |
| C-BR-21 | User sees a non-stale reservation conflict           | Offer only an owning-run link; do not expose force-rerun or reservation release.                                           | UI + PipelineService           | UI + integration   |
| C-BR-22 | Stale reservation candidate                          | Treat a reservation as stale only when the owning run is non-terminal, `last_seen_at` is older than the configured threshold, and no related terminal/coordinator/stage process is active. | PipelineService reservation manager | Integration |
| C-BR-23 | Closure-capable template stage completes             | Pipeline confirms the GitHub issue is closed before treating the task as complete.                                         | PipelineService closure gate   | Integration        |
| C-BR-24 | Closure-capable stage finishes but issue remains open | Treat the task as not complete and stop or re-plan according to template policy; do not silently advance dependent work.    | PipelineService closure gate   | Integration        |
| C-BR-25 | RALPH/sequential template is selected                | Each iteration works one issue and must pass verify, commit, and close before the next issue iteration starts.              | Template runner                | Integration        |
| C-BR-26 | Parallel planner template is selected                | Merger receives `CLOSE_TASK_COMMAND`; after merge/test it closes merged issues before the next planner iteration.           | Template runner                | Integration        |
| C-BR-27 | Run input uses a non-derived Pipeline PRD label       | Reject the run; the only valid Pipeline PRD label for PRD `N` is `pipeline:prd-N`.                                         | PipelineService validation     | Unit               |
| C-BR-28 | Selected PRD issue is closed                         | Reject the run before listing or planning tasks; closed PRDs are history-only and cannot create new Pipeline runs.          | PipelineService preflight      | Unit + integration |
| C-BR-29 | Restart finds a non-terminal run whose terminal/coordinator/stage processes are gone | Collect Pipeline DB state, terminal/process state, worktree dirty/commit state, GitHub issue state, and logs; write a recovery report; mark the old run and incomplete DB rows `interrupted`; release the reservation. | PipelineService startup reconciliation | Integration |
| C-BR-30 | User launches a replacement run while the latest recovery report for that PRD work set is pending | Reject the launch and return the latest pending recovery report id; acknowledgement must happen through the recovery-report acknowledgement RPC first. | PipelineService preflight      | Unit + integration |
| C-BR-31 | User acknowledges a recovery report                 | Mark only the selected report acknowledged and enable replacement launch for that PRD work set when it was the latest pending report; do not create a run, resume old in-memory state, auto-merge preserved worktrees, continue dirty worktrees, auto-close issues, or mutate older pending reports. | PipelineService recovery report manager | Integration |
| C-BR-32 | Parent PRD issue closes during an active run        | At the next safe checkpoint, stop new planning, dispatch, merge, and issue closure; mark the run `cancelled` with `status_reason=prd_closed`; release the reservation and preserve worktrees/logs. | PipelineService checkpoint     | Integration        |
| C-BR-33 | Pipeline reaches a PRD-open checkpoint              | Re-read the parent PRD issue state before planner start, before each new planner iteration, before dispatching a worker batch, before review, before merge, before verify, and before issue closure. If the PRD is closed, apply C-BR-32. | PipelineService checkpoint     | Unit + integration |
| C-BR-34 | Pipeline starts executing a task issue              | Do not remove `ready-for-agent`, do not add `in-progress` or `claimed` labels, and do not rely on GitHub labels as the execution lock. Pipeline completion is determined by the issue closure gate. | PipelineService + TaskSource adapter | Unit + integration |
| C-BR-35 | User launches a replacement run after acknowledging the latest recovery report | Create a new run from the current open PRD ready task set; closed issues stay out and preserved worktrees remain inspectable evidence only. | PipelineService preflight      | Integration        |
| C-BR-36 | First replacement run is created after an acknowledged recovery report | Set `replacesRunId` to the interrupted run and `recoveryReportId` to the acknowledged recovery report. A recovery report may link to only one direct replacement run; later runs for the same PRD work set leave these fields empty unless there is a newer interrupted run and recovery report. | PipelineService preflight | Unit + integration |
| C-BR-37 | Replacement run reaches any terminal state          | Do not mutate the replaced run's `interrupted` status. Show follow-up through lineage fields only.                         | PipelineService status writer  | Unit + integration |
| C-BR-38 | Replacement run is interrupted                      | Generate a new recovery report for that replacement run, not for the original interrupted run. The next replacement links to the newly interrupted run and new recovery report. | PipelineService startup reconciliation | Integration |
| C-BR-39 | Multiple pending recovery reports exist for one PRD work set | Use only the latest pending report as the launch blocker and top PRD-tab alert. Older pending reports are not required before launch. | PipelineService preflight + UI read model | Unit + UI |
| C-BR-40 | Latest pending recovery report is acknowledged while older pending reports exist | Leave older pending reports unchanged. They remain readable history or diagnostic records and must not block replacement launch. | PipelineService recovery report manager | Unit + integration |
| C-BR-41 | User tries to retry a failed stage directly         | Do not expose or execute stage-level retry in v1; preserve logs/worktrees and require follow-up through a new Pipeline run. | CLI/RPC/UI surface checks       | Unit + UI          |

## Iteration Loop Contract

| ID       | Stop condition                                    | Stop reason       | Behavior                                                                 |
| -------- | ------------------------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| C-ITER-1 | Planner returns zero tasks                        | `empty_plan`      | Stop successfully; no more work is available for this run.               |
| C-ITER-2 | Iteration planned tasks but completed zero tasks  | `no_progress`     | Stop to avoid re-running the same blocked or ineffective plan forever.   |
| C-ITER-3 | `maxIterations` iterations have completed         | `max_iterations`  | Stop even if the planner might still find more work.                     |
| C-ITER-4 | Any iteration fails                               | `failed`          | Stop immediately and preserve failed stage/worktree evidence.            |
| C-ITER-5 | User cancels the run                              | `cancelled`       | Stop immediately and keep inspectable task/merge worktrees by default.   |
| C-ITER-6 | Iteration completes at least one planned task     | continue          | Run the planner again until one of the stop conditions above is reached. |
| C-ITER-7 | Startup reconciliation finds execution is gone    | `interrupted`     | Stop the old run as interrupted and require recovery report acknowledgement before a replacement run. |
| C-ITER-8 | Parent PRD is closed at a safe checkpoint         | `prd_closed`      | Cancel the run without starting new planner, worker, review, merge, verify, or issue-closure work. |

## Backend State

| ID     | State                     | Owner           | Transitions                                                                                                          | Transaction/permission rule                                     |
| ------ | ------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| C-ST-1 | Pipeline run status       | PipelineService | pending -> planning -> dispatching -> executing -> reviewing -> merging -> verifying -> completed/failed/cancelled/interrupted | Each transition writes a log row; terminal states are immutable, including replaced `interrupted` runs. |
| C-ST-2 | Pipeline iteration status | PipelineService | pending -> planning -> executing -> reviewing -> merging -> verifying -> completed/failed/cancelled/interrupted | Iteration belongs to one run. |
| C-ST-3 | Pipeline task status      | PipelineService | planned -> worktree_created -> dispatched -> implemented -> reviewed/no_changes -> merged/skipped -> verified/failed/interrupted | Task belongs to one iteration. |
| C-ST-4 | Orchestration task status | OrchestrationDb | pending/ready/dispatched/completed/failed/blocked                                                                    | Existing coordinator rules remain source of truth for dispatch. |
| C-ST-5 | Pipeline recovery report status | PipelineService | pending_ack -> acknowledged | Replacement launch is blocked while the latest report for that PRD work set is `pending_ack`; acknowledged reports and non-latest pending reports remain readable history. Acknowledging the latest report does not cascade status changes to older reports. |

## Frontend State

| ID     | State         | Owner                | Transitions                        | Visible result                                      |
| ------ | ------------- | -------------------- | ---------------------------------- | --------------------------------------------------- |
| C-FE-1 | Template list | UI query cache/store | load -> loaded/error               | Automations Pipelines tab template picker.          |
| C-FE-2 | Run history   | UI query cache/store | load -> refresh after events       | Automations Pipelines tab run table.                |
| C-FE-3 | Run detail    | UI query cache/store | load -> polling/event updates      | Stage timeline, task rows, terminal/worktree links. |
| C-FE-4 | Cancel action | UI component + RPC   | idle -> pending -> cancelled/error | Cancel button disabled while pending.               |
| C-FE-5 | Linear Pipeline mode | UI read model        | load -> refresh/polling updates    | Existing Linear Tasks board with Orca runtime status overlay and mutating actions disabled. |
| C-FE-6 | Task preview  | UI read model        | load -> refresh/polling updates    | Full PRD ready task set, without per-task checkboxes or drag sorting. |
| C-FE-7 | Reservation conflict | UI component + RPC   | conflict -> open owning run / confirm stale release | No force-rerun action. |
| C-FE-8 | Template selection | UI component + RPC | default parallel -> explicit user selection | Default is `parallel-planner-with-review`; `sequential-reviewer` is explicit strict mode, is never auto-selected, and forces `maxConcurrent = 1`. |
| C-FE-9 | Concurrency control | UI component + RPC | visible for parallel -> hidden for sequential | Hide concurrency input when `sequential-reviewer` is selected. |
| C-FE-10 | Linear Pipeline mode | Existing Linear Tasks board + Pipeline overlay | normal Tasks board -> read-only Pipeline mode | Disable drag status changes, new issue creation, inline issue editing, and direct Start workspace; allow opening source pages and Pipeline detail. |
| C-FE-11 | Pipeline PRD tabs | UI component + PRD tab store | open tab -> select PRD work set -> close tab | Each tab selects one Pipeline PRD work set, keyed by repo, provider repo, PRD issue number, and Pipeline PRD label; local/SSH execution targets do not create separate tabs. |
| C-FE-12 | PRD board filtering | UI read model | selected PRD work set -> PRD task set -> filtered board | Hide Linear cards that do not match a GitHub task issue in the selected PRD work set; show GitHub-only cards for PRD tasks without a Linear match. |
| C-FE-13 | Pipeline PRD label derivation | UI/CLI input model | PRD issue number -> exact Pipeline PRD label | Pipeline PRD label is exactly `pipeline:prd-<number>`. |
| C-FE-14 | Recent PRD tabs | UI persisted settings/store | open/select/close tab -> persist recent tabs -> restore after restart -> refresh PRD data | Restored tabs are navigation state only; GitHub issues and Pipeline DB remain task truth. |
| C-FE-15 | Linear task matching | UI read model | Linear card -> explicit GitHub issue URL/number match -> Pipeline overlay or hidden | Only matched Linear cards in the selected PRD work set are shown; PRD GitHub tasks without a match render as GitHub-only cards. |
| C-FE-16 | Runnable task board | UI read model | selected PRD work set -> open ready task query -> board rows; closed tasks -> run history/detail only | Main board shows remaining executable work only; completed issue evidence is shown from run history and task detail. |
| C-FE-17 | GitHub-only board fallback | UI read model | Linear unavailable/disconnected -> PRD GitHub task rows | Pipeline UI remains usable without Linear; no Linear connection prompt blocks PRD task viewing or run launch. |
| C-FE-18 | Orca development context panel | UI read model | selected PRD work set/run -> repo/worktree/branch/execution-target summary -> links refresh with run state | Shows local or SSH target, repo/worktree identity, source branch, target branch, active run, and available worktree/terminal links; target selection is editable only before an active run exists and read-only while the active run owns the PRD work set reservation. |
| C-FE-19 | Smart PRD picker | UI read model + RPC | load candidates -> choose one open PRD -> derive Pipeline PRD label -> preview full PRD ready task set -> launch | Shows recent open PRD candidates with derived `pipeline:prd-N`; closed PRDs are omitted from launch choices; manual PRD issue entry is advanced fallback only. |
| C-FE-20 | Recovery report gate | UI read model + RPC | startup/reload -> show latest pending report -> user acknowledges -> replacement launch enabled | If a latest pending recovery report exists for the selected PRD work set, the UI must show completed/open tasks, preserved/dirty worktrees, live/missing terminals, and require acknowledgement before enabling a replacement run. Dirty worktree actions are inspect-only, such as opening the worktree or terminal; no one-click merge, continue, commit, close issue, or resume action is exposed. |
| C-FE-21 | PRD-tab recovery alert | UI component + RPC | selected PRD tab has latest pending recovery report -> top blocking alert -> expanded recovery report panel -> acknowledgement | The alert appears only inside the matching PRD tab, blocks replacement launch for that PRD work set, and must not be implemented as a global modal or app-wide popup. |
| C-FE-22 | Recovery acknowledgement separation | UI component + RPC | acknowledge report -> alert clears -> launch controls enabled -> user explicitly starts run | Acknowledgement never auto-submits `pipelines.run`; the user must start the replacement run as a second action after reviewing current run settings. |
| C-FE-23 | Acknowledged recovery report history | UI read model + RPC | acknowledgement -> non-blocking history row/detail | Acknowledged recovery reports stay visible in the matching PRD tab's run history or recovery history area with expandable details, but they do not disable launch controls. |
| C-FE-24 | Replacement lineage display | UI read model | replacement run linked to recovery report -> run history/detail cross-links | Run history and detail show `replacesRunId` and `recoveryReportId` when present, with links from replacement run to interrupted run and recovery report. |
| C-FE-25 | Replaced interrupted run display | UI read model | interrupted run has replacement -> interrupted row/detail shows follow-up link | The original run remains visually `interrupted` and may show "replaced by run X"; it must not appear completed or resolved. |
| C-FE-26 | Recovery chain display | UI read model | chained replacement runs -> ordered recovery lineage | Run history/detail can show a chain such as run A interrupted -> run B replacement interrupted -> run C replacement, while each run keeps its own terminal status. |
| C-FE-27 | Latest pending recovery prompt | UI read model | multiple pending reports -> latest pending alert only | The top PRD-tab alert shows only the latest pending recovery report. Older pending reports, if any, do not create additional blocking prompts. |
| C-FE-28 | Non-latest pending recovery history | UI read model | latest pending acknowledged -> launch enabled; older pending unchanged | Older non-latest pending reports may remain visible in history/diagnostic details, but they do not create alerts or disable launch controls. |
| C-FE-29 | Non-blocking pending recovery label | UI read model | non-latest `pending_ack` report -> historical/non-blocking display label | The UI labels older non-latest pending reports as historical and non-blocking in history/detail surfaces without changing their stored `pending_ack` status. |
| C-FE-30 | Failed stage inspect-only display | UI read model | failed stage -> logs/worktree/terminal links only | Failed stage details expose evidence and navigation links, but no retry-stage button or direct stage retry action. |

## Traceability

| Requirement | Contract                      | Code target                                             | Test target                                   | Live evidence                              |
| ----------- | ----------------------------- | ------------------------------------------------------- | --------------------------------------------- | ------------------------------------------ |
| R1-R4       | C-RPC-2, C-DB-1..4, C-BR-1..5, C-BR-13..14 | `src/main/pipelines/*`, `src/shared/pipelines-types.ts` | PipelineService and OrchestrationBridge tests | GitHub run with prepared PRD-labeled issues |
| R5-R7       | C-DB-3, C-BR-6..10            | Worktree launcher, review/merge/verify runners          | Integration tests with git fixture            | Worktree cards and terminal links          |
| R8          | C-DB-2, C-BR-11               | Pipeline iteration loop                                 | Multi-iteration integration test              | Planner runs at least twice                |
| R9          | C-RPC-2, C-FE-3               | Automation target integration                           | Automation service test                       | Scheduled/manual automation launches a run |
| R10         | C-DB-6                        | Prompt renderer                                         | Dynamic context security tests                | Failed malicious issue-body injection      |
| R11-R49     | C-RPC-3..10, C-ST-1..5, C-FE-5..30, C-BR-16..41, C-ITER-7..8 | UI/CLI and logs                                         | RPC/UI tests                                  | Run detail page, Linear Pipeline mode, GitHub-only board fallback, smart PRD picker, PRD tabs, local/SSH development context, recovery report gate, PRD-tab recovery alert, separated recovery acknowledgement, acknowledged recovery history, replacement lineage, immutable interrupted status, recovery chain display, latest pending recovery prompt, non-latest pending history, non-blocking pending recovery label, inspect-only failed stage, PRD closure cancellation, PRD-open checkpoint coverage, readiness-label immutability, and CLI show output |
