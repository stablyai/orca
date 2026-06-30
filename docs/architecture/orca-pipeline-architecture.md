# Orca Pipeline Architecture

## Source

- PRD: `docs/prd/orca-sandcastle-like-pipeline.md`
- RPC and DB contract: `docs/contracts/pipeline-rpc-db.md`
- Template and prompt contract: `docs/contracts/pipeline-template-prompt.md`
- Testing plan: `docs/testing/pipeline-verification.md`

## Existing System Facts

| Area | Existing code | Fact |
| --- | --- | --- |
| Automations | `src/shared/automations-types.ts`, `src/main/automations/service.ts` | Automation currently stores a prompt-oriented run and asks the renderer to dispatch it. |
| Orchestration | `src/main/runtime/orchestration/coordinator.ts` | Coordinator requires tasks to be created before run start. It does not plan tasks itself. |
| Orchestration RPC | `src/main/runtime/rpc/methods/orchestration.ts` | `orchestration.taskCreate` creates task DAG rows; `orchestration.taskList` surfaces active dispatch metadata. |
| Worktrees | `src/main/runtime/rpc/methods/worktree.ts` | Managed worktrees can be created with branch overrides, linked issues, startup agents, and lineage metadata. |
| Terminal launch | `src/renderer/src/lib/launch-agent-background-session.ts` | Background terminal sessions can run locally, over SSH, or through runtime environments. |
| Sandcastle | `src/templates/parallel-planner-with-review/main.mts` in upstream | Planner, implementer, reviewer, and merger are separate stages; multi-iteration planning is part of the template. |

## Layer Ownership

| Layer | Owns | Must not own |
| --- | --- | --- |
| Automations | Schedule, precheck, trigger, and result link to a Pipeline Run. | Planning, task DAG creation, worker dispatch, merge, verify. |
| Pipeline | Template execution, task source snapshot, planner output parsing, task-to-worktree mapping, review/merge/verify policy, multi-iteration loop, run history. | Low-level terminal transport or generic inbox message semantics. |
| Orchestration | Generic task DAG dispatch, worker_done, heartbeat, escalation, decision gates, dependency promotion. | Pipeline planning, issue-source policy, branch merge policy, template rendering. |
| Worktree/Terminal | Runtime environment for agents and commands. | Pipeline status ownership. |
| Skills/Issues/Docs | Prepare tasks and durable context. | Runtime execution decisions. |
| Linear Tasks board | Existing Orca Linear Tasks/board surface reused in read-only Pipeline mode. | Task truth, issue editing, drag status changes, new issue creation, direct workspace start, runtime status ownership. |

## Pipeline-Orchestration Boundary

Best design:

1. Pipeline creates `pipeline_runs`, `pipeline_iterations`, and `pipeline_tasks`.
2. Planner emits structured tasks for the current iteration.
3. Pipeline creates one managed worktree per planned task.
4. Pipeline creates generic Orchestration tasks with enough execution metadata to target the correct worktree.
5. Coordinator dispatches ready Orchestration tasks and reports completion through existing `worker_done` messages.
6. Pipeline observes Orchestration task completion and inspects git state in each task worktree.
7. Pipeline runs review, merge, verify, and next iteration logic outside the coordinator.

This keeps Orchestration generic. The only Orchestration extension should be a generic execution context, such as task `worktree_id` or `worktree_selector`, not fields named after Pipeline.

## Multi-Worktree Strategy

Chosen strategy: **one managed worktree per Pipeline Task, plus one merge worktree per iteration**.

| Concern | Why this is best |
| --- | --- |
| User management | Each task appears as a normal Orca worktree card with branch, linked issue, status, terminal, and diff. |
| Interactions | The user can open, pause, inspect, or recover one task without digging through a shared terminal. |
| Agent context accuracy | Implementer and reviewer both run inside the task branch and see only that task's code changes. |
| Merge safety | Merge happens in a dedicated worktree, so failed merges do not corrupt task worktrees. |
| SSH support | Worktree creation and terminal launch continue using Orca's existing local/SSH/runtime paths. |

Rejected options:

| Option | Why rejected |
| --- | --- |
| One shared worktree for all tasks | Hard for users to inspect, easy for agents to mix contexts, high merge-conflict risk. |
| One coordinator run per task only | Simple worktree targeting, but loses useful DAG dispatch and concurrency control. |
| Hidden temporary directories outside Orca worktrees | Recreates Sandcastle sandbox behavior and makes recovery worse for users. |

## Stage Flow

```text
Pipeline Run
  -> Iteration 1
     -> task source snapshot
     -> planner terminal/worktree
     -> structured <plan> extraction
     -> task worktrees
     -> orchestration.taskCreate rows
     -> coordinator run
     -> implement worker terminals
     -> review terminals for branches with commits
     -> merge worktree/terminal
     -> verify commands
  -> Iteration 2..N if maxIterations allows and work remains
```

## Automation Target Design

Automation should gain a target union:

```ts
type AutomationTarget =
  | { type: 'prompt'; prompt: string }
  | {
      type: 'pipeline'
      pipelineTemplateId: string
      pipelineInput: PipelineRunInput
    }
```

Compatibility rule:

- Existing automations migrate to `{ type: 'prompt', prompt }`.
- Automation run history stores `pipelineRunId` when the target is `pipeline`.
- Automation precheck still runs before target dispatch.
- Automation usage attribution should link to the Pipeline Run and summarize stage-level usage when available.

## Review, Merge, Verify Ownership

| Stage | Owner | Worktree | Completion source |
| --- | --- | --- | --- |
| Implement | Coordinator dispatches; Pipeline observes. | Task worktree. | `worker_done` plus git inspection. |
| Review | Pipeline launches reviewer after implemented branch has commits. | Same task worktree. | Reviewer terminal exit/promise plus git inspection. |
| Merge | Pipeline launches merger. | Iteration merge worktree. | Merge terminal exit/promise plus git state. |
| Verify | Pipeline runs configured verify commands. | Merge worktree. | Command results and live verification notes. |

Pipeline must not trust agent text alone for commits. It should inspect git state before deciding whether a branch has commits to review or merge.

## Sandcastle-Style Issue Closure Gate

GitHub task issue closure follows Sandcastle templates. Closure-capable stages receive `CLOSE_TASK_COMMAND` and close issues after the template's required verification step.

For the parallel planner template, the merger closes merged issues after merge and test verification. For a RALPH-style sequential template, each iteration works one issue and closes it before the next issue iteration starts.

PipelineService does not close issues on behalf of the agent. It records and verifies the closure gate: a task is complete only when its GitHub issue is closed. If the issue remains open, dependent or later planner work must not treat it as completed.

## Pipeline UI Task Board

Pipeline UI uses GitHub issues as the task source of truth and reuses Orca's existing Linear Tasks/board surface in read-only Pipeline mode. This is not a separate fake board and not an embedded Linear website. Linear cards can show issue identity and board position, while Orca overlays live Pipeline status from `pipeline_runs`, `pipeline_tasks`, and `pipeline_stages`.

Linear is optional. If Linear is disconnected, unavailable, or has no matching cards, Pipeline UI still renders the selected PRD work set from GitHub issues as GitHub-only task cards. The user can inspect the PRD task set and launch a run without connecting Linear.

Pipeline mode disables mutating Linear Tasks actions: dragging cards to change state, creating Linear issues, inline issue editing, and direct Start workspace actions. It keeps navigation actions such as opening the original Linear/GitHub page and opening Pipeline run detail.

Pipeline UI shows browser-like tabs for Pipeline PRD work sets. A PRD tab is keyed by the selected Orca repo, provider repo, PRD issue number, and Pipeline PRD label. Selecting a tab selects that PRD work set, not one specific run or execution target. Choosing local versus SSH changes launch settings and run context inside the tab; it never creates another tab for the same PRD work set.

Recent PRD tabs are persisted locally and restored after app restart. A restored tab is only a shortcut back to that PRD work set; the board, active run, and run history must refresh from GitHub issues and Pipeline DB before showing current status.

The primary launch entry is a smart PRD picker. It loads recent open PRD candidates from GitHub PRD issues, task-slice issues carrying the exact derived Pipeline PRD label whose parent PRD is open, and existing active Pipeline run/reservation records for open PRDs. Candidates are grouped by PRD issue, and each row shows the PRD title, derived `pipeline:prd-N` label, ready task count, latest update time, and active run/reservation indicator when present. Closed PRDs are omitted from launch candidates and remain visible only through run history or completion evidence. Choosing a candidate fills the PRD issue number, derives the Pipeline PRD label, and previews the full PRD ready task set. Manual PRD issue entry remains available as an advanced fallback.

The board in that tab shows only tasks from the selected PRD work set. The tab also shows the active run for that PRD work set, if any, and a run history for previous attempts. Linear cards are included only when Orca can match them to a GitHub task issue in the selected PRD work set. A match requires an explicit GitHub issue URL or issue number in a Linear external link, description, or title. Unmatched Linear cards are hidden. If a PRD task has no matching Linear card, Pipeline UI still shows it as a GitHub-only task so a real task never disappears from the PRD view.

The main board is a runnable-work view. It shows only current `open` issues with `task-slice`, `ready-for-agent`, and the selected Pipeline PRD label. Closed task issues are not shown on the main board; they appear in run history, task detail, and completion evidence for the run that closed them.

Each PRD tab also shows the selected Orca development context: execution target (`local` or SSH target), repo/worktree identity, source branch, target branch, active run, and available worktree or terminal links. This context comes from Orca runtime and Pipeline DB state, not from Linear. The execution target selector is editable before launch. While the selected PRD work set has an active run, the selector shows the owning run's target as read-only; after the run reaches a terminal state and releases its reservation, the next launch can choose local or SSH again.

The UI and CLI launch forms require a PRD issue number. Pipeline first validates that the PRD issue is open, derives the only valid Pipeline PRD label as `pipeline:prd-<number>`, then lists only GitHub issues that are `open`, `task-slice`, `ready-for-agent`, and tagged with that derived label. The PRD issue number is also used to validate that every selected task belongs to the expected PRD before planning starts.

Pipeline does not claim task issues by mutating GitHub labels when execution starts. It leaves `ready-for-agent` in place, does not add `in-progress` or `claimed`, and relies on the active run reservation to prevent duplicate Pipeline runs for the same PRD work set. Pipeline's own completion flow removes a task from the runnable set by closing its GitHub issue after the closure gate passes. Rare external label edits during an active run are not a v1 control path.

Neither UI nor CLI lets the user hand-pick issue numbers for a run. The planner receives the full PRD ready task set and decides execution order.

The smart PRD picker follows the same rule. It selects one PRD work set, not task groups or task issues inside that work set. It must not expose per-task checkboxes, drag sorting, issue exclusion, or task grouping controls.

If the launch preview finds zero PRD ready tasks, UI and CLI block the launch instead of creating an empty run. A later iteration that finds no more work still completes normally.

Pipeline also checks the parent PRD issue at safe checkpoints between stages. The checks run before planner start, before each new planner iteration, before dispatching a worker batch, before review, before merge, before verify, and before issue closure. If the PRD is closed while a run is active, Pipeline lets the currently running stage reach its normal boundary, then stops starting new planner, worker, review, merge, verify, or issue-closure work. The run is marked `cancelled` with `status_reason=prd_closed`, the active reservation is released, and worktrees/logs remain inspectable. Reopening the PRD later permits a new run; the old cancelled run is not resumed.

## Active Run Reservation

Pipeline creates a PRD-work-set-bound active run reservation before planner launch. The reservation key is the selected Orca repo, provider repo, PRD issue number, and Pipeline PRD label. This is a simple active-run check: it records that this PRD work set is already being handled by one Pipeline run inside the same Orca runtime, regardless of whether a second launch selects local or SSH execution.

The reservation is local to the Orca runtime. Orca does not promise a global reservation across different user computers. Terminal run states release the reservation in the final-state transaction. After restart, Pipeline reconciles every non-terminal run before accepting replacement launches for the same PRD work set.

If the previous terminal/coordinator/stage processes are still alive, Orca reconnects monitoring, preserves the reservation, and shows the owning run. If those processes are gone, Orca collects a recovery report from Pipeline DB rows, terminal/process checks, preserved worktrees, GitHub issue states, commits, dirty worktree status, logs, and completion evidence. It marks the old run and incomplete DB rows as `interrupted`, releases the reservation, and shows a blocking recovery alert at the top of the matching PRD tab with an expandable recovery report panel. The recovery prompt is never a global modal or app-wide popup.

If multiple pending recovery reports exist for the same PRD work set, the launch gate and top PRD-tab alert use only the latest pending report by `created_at`, then id. Older pending reports do not create extra blocking prompts. Acknowledging the latest report does not mutate those older reports; they remain readable history or diagnostic records and do not block launch. In history/detail UI, older non-latest `pending_ack` reports are labeled as historical and non-blocking using a derived display label, not a new database status.

A replacement run is never an automatic resume of the old in-memory execution. The user must acknowledge the latest recovery report before launch, and acknowledgement only clears the block; it does not start a run. After acknowledgement, the report remains visible in the matching PRD tab as non-blocking history with expandable details. The user then starts a replacement run as a separate action after confirming the execution target, template, and current task preview. The first replacement run created after that acknowledgement records `replacesRunId` and `recoveryReportId` so run history can link the replacement run to the interrupted run and recovery report. The same recovery report is not reused by later runs. The replaced run remains `interrupted` even if the replacement later succeeds; UI may show a follow-up link, but it must not rewrite the old run status. If the replacement run is also interrupted, Pipeline creates a new recovery report for that replacement run and the next replacement links to the new report. This allows a visible chain such as run A interrupted -> run B replacement interrupted -> run C replacement, while every run keeps its own terminal status. The new run reads the current open PRD ready task set from GitHub; closed issues stay out, open ready issues can be planned again, and preserved worktrees remain inspectable evidence unless the user manually acts on them outside Pipeline. Dirty worktrees in the report expose only inspection actions such as opening the worktree or terminal; Pipeline UI does not provide one-click merge, continue, commit, close issue, or resume for them.

Stage-level retry is not a v1 public operation. Failed stages remain inspectable through logs, terminal links, worktree links, raw output summaries, and run history. Follow-up execution starts through a new Pipeline run from current GitHub task truth, not a retry-stage RPC, CLI command, or UI button.

On a reservation conflict, UI and CLI link to the owning run. They do not expose a force-rerun action. A stale-reservation release action appears only when the backend classifies the reservation as stale, and the user must confirm the release explicitly.

A reservation is stale only when the owning run is non-terminal, `last_seen_at` is older than the configured threshold, and Orca cannot find an active terminal, coordinator, or stage process for that run. Time alone is not enough to release a reservation.
