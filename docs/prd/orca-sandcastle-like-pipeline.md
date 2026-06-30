# PRD: Orca Sandcastle-like Pipeline

## Source

- Planning handoff: `/tmp/orca-sandcastle-pipeline-handoff-2026-06-05.md`
- Source plan: `/home/ljian/wspace/orca-scryer/ORCA_SANDCASTLE_PIPELINE_PLAN.md`
- Source implementation reference: `/home/ljian/wspace/orca-scryer/sandcastle-upstream`
- Target worktree: `/home/ljian/wspace/orca-scryer/orca-main-pipeline-design`
- Issue tracker: `Nikolatesla-lj/orca`
- PRD issue: https://github.com/Nikolatesla-lj/orca/issues/2

## Design Status

- Status: frozen for v1 implementation as of 2026-06-05.
- Frozen v1 behavior includes the PRD work set model, PRD-labeled GitHub task source, local/SSH execution targets, active run reservation, Sandcastle-style issue closure gate, restart recovery, PRD-tab UI, read-only Linear mode, and inspect-only failed stages.
- Any v1 behavior change after this point must update this PRD, both contract docs, task slices, and the testing plan together before code implementation continues.

## Task Issues

| Slice | Issue |
| --- | --- |
| S1 Setup PRD, contracts, and issue tracker | https://github.com/Nikolatesla-lj/orca/issues/3 |
| S2 Add shared Pipeline types and DB schema | https://github.com/Nikolatesla-lj/orca/issues/4 |
| S3 Implement template registry, prompt renderer, and structured output parser | https://github.com/Nikolatesla-lj/orca/issues/5 |
| S4 Implement PRD-labeled GitHub task source and planner stage | https://github.com/Nikolatesla-lj/orca/issues/6 |
| S5 Implement per-task worktrees and OrchestrationBridge | https://github.com/Nikolatesla-lj/orca/issues/7 |
| S6 Implement review, merge, verify, and multi-iteration loop | https://github.com/Nikolatesla-lj/orca/issues/8 |
| S7 Add Pipeline RPC methods and CLI commands | https://github.com/Nikolatesla-lj/orca/issues/9 |
| S8 Add Pipeline UI and Automation pipeline target | https://github.com/Nikolatesla-lj/orca/issues/10 |
| S9 Run full live verification and drift check | https://github.com/Nikolatesla-lj/orca/issues/11 |

## Problem

Orca can already run agents, manage worktrees, launch terminals, and coordinate task dispatch. It does not yet have a Sandcastle-like execution layer that can consume prepared issues, plan safe parallel work, run implement/review/merge/verify stages, and show a durable history of what happened.

## Goal

Build an Orca-native Pipeline feature that executes already prepared task slices with a Sandcastle-like flow:

1. Read prepared GitHub task issues selected by `open` state, `task-slice`, `ready-for-agent`, and a required Pipeline PRD label.
2. Run a planner agent that emits structured `<plan>` JSON.
3. Create managed worktrees and orchestration tasks for planned work.
4. Dispatch implementer agents in parallel.
5. Review branches that produced commits.
6. Merge successful branches.
7. Verify the merged result.
8. Repeat planning for multiple iterations when newly unblocked tasks appear.
9. Close completed task issues through the Sandcastle-style template close command after the template's required verification step.
10. Persist run, iteration, task, stage, terminal, worktree, error, and verification history.
11. Expose CLI and UI controls for running, inspecting, cancelling, and reviewing Pipeline runs.
12. Reuse Orca's existing Linear Tasks/board surface inside Pipeline UI in read-only Pipeline mode with Orca runtime status overlaid from Pipeline state.
13. Restore recent Pipeline PRD tabs after app restart as UI shortcuts, while refreshing task truth from GitHub issues and Pipeline run history.
14. Keep Pipeline UI usable without Linear by showing the PRD-labeled GitHub task board and local/SSH Orca development context.
15. Let users start from a smart PRD picker that lists recent open runnable PRDs instead of requiring manual PRD issue number entry.

## Non-Goals

- Do not rewrite Matt Pocock skills.
- Do not hard-code `/grill-with-docs`, `/to-prd`, `/to-issues`, or `/triage` into the Pipeline runtime.
- Do not build a Skill Profile or setup wizard in this phase.
- Do not build a PRD-to-task wizard in this phase.
- Do not migrate Docker, Podman, Vercel, or Sandcastle sandbox providers.
- Do not copy Sandcastle's AgentProvider layer.
- Do not use GitHub Actions as a Pipeline execution target.
- Do not make Linear, manual task entry, or the Pipeline UI a second task source of truth.
- Do not edit issue descriptions, labels, assignees, PRD docs, or local design docs from the Pipeline UI.
- Do not let users hand-pick or reorder individual task issues in the Pipeline UI.
- Do not expose a CLI option that narrows a run to hand-picked issue numbers.

## Requirements

| ID | Requirement |
| --- | --- |
| R1 | Pipeline consumes prepared tasks, not vague free-form requirements. |
| R2 | Pipeline supports GitHub issue task sources from `Nikolatesla-lj/orca`; the runnable issue set is `open` + `task-slice` + `ready-for-agent` + required Pipeline PRD label. |
| R3 | Planner output is extracted from the last `<plan>...</plan>` block, JSON parsed, and schema validated. |
| R4 | Planner output creates Pipeline Tasks and generic Orchestration tasks before the coordinator starts. |
| R5 | Each Pipeline Task gets its own managed worktree and deterministic branch name. |
| R6 | Implement and review stages run in the same task worktree and branch. |
| R7 | Merge and verify run in a dedicated merge worktree for the Pipeline iteration. |
| R8 | v1 supports multi-iteration planning with `maxIterations`, defaulting to the template value. |
| R9 | Automation can trigger a Pipeline Run, but Automations do not plan, dispatch, merge, or verify directly. |
| R10 | Dynamic context commands can only come from the raw template text and must be bounded by timeout and output limits. |
| R11 | Pipeline records enough state to inspect failures without relying on chat history. |
| R12 | UI and CLI expose template list, run, list, show, cancel, and logs. |
| R13 | Usage attribution records provider/model/token/cost at task or stage granularity when available. |
| R14 | Completion evidence includes tests, live verification, drift check, and traceability back to PRD/task/contracts. |
| R15 | The PRD issue number is retained in the launch form and used to validate each task issue's parent PRD before planning. |
| R16 | The Pipeline UI reuses Orca's existing Linear Tasks/board surface in read-only Pipeline mode; real-time execution status comes from Orca Pipeline state, not from Linear. |
| R17 | The Pipeline UI derives the Pipeline PRD label from the PRD issue number as exactly `pipeline:prd-<number>`, previews that full ready task set, and cannot narrow or reorder it. |
| R18 | UI and CLI both launch the same PRD ready task set; user-facing run input cannot include individual issue-number selection. |
| R19 | UI and CLI preflight reject a new run when the PRD ready task set is empty; zero tasks during a later iteration can complete the run normally. |
| R20 | Pipeline creates an active run reservation for the selected repo, provider repo, PRD issue number, and Pipeline PRD label, preventing duplicate active runs for that PRD work set inside the same Orca runtime. |
| R21 | On reservation conflict, UI/CLI link to the owning run; stale reservation release requires explicit confirmation and no force-rerun action is exposed. |
| R22 | Pipeline uses a Sandcastle-style issue closure gate: a task is complete only after the template verifies the work and closes the GitHub issue with the provided close command. |
| R23 | Pipeline UI defaults to `parallel-planner-with-review` and also allows explicit user selection of `sequential-reviewer` / RALPH for strict one-issue-at-a-time closure; Orca does not auto-switch templates. |
| R24 | When `sequential-reviewer` / RALPH is selected, Pipeline forces `maxConcurrent = 1` and hides concurrency controls from the UI. |
| R25 | Pipeline UI shows only tasks that belong to the selected PRD work set; unmatched Linear cards are hidden. |
| R26 | Pipeline PRD work sets are shown as browser-like PRD tabs; runs are execution records inside the selected PRD tab, and local/SSH execution targets do not create separate tabs. |
| R27 | v1 supports exactly one Pipeline PRD work set per PRD: `pipeline:prd-<number>`; UI, CLI, and RPC accept only that derived label. |
| R28 | Pipeline UI persists recent PRD tabs locally across app restart, but restored tabs are only UI state; task status and runnable task truth must be reloaded from GitHub issues and Pipeline DB. |
| R29 | Pipeline UI matches Linear cards to PRD GitHub task issues only through explicit GitHub issue URLs or issue numbers in Linear external links, descriptions, or titles. |
| R30 | Pipeline PRD tab task boards show only currently runnable open tasks in the selected PRD work set; closed task issues appear only through run history and completion evidence. |
| R31 | Pipeline UI remains usable when Linear is disconnected or unavailable by rendering the selected PRD work set as a GitHub-only task board. |
| R32 | Pipeline UI shows the selected Orca development context: local or SSH execution target, repo/worktree identity, source branch, target branch, active run, and related worktree/terminal links when available; the execution target selector is editable only when the selected PRD work set has no active run. |
| R33 | Pipeline UI provides a smart PRD picker that lists recent GitHub PRDs with their derived `pipeline:prd-<number>` labels, ready task counts, recency, and active run/reservation state. |
| R34 | The smart PRD picker must not let users hand-pick, exclude, reorder, or split task issues; after a PRD is chosen, Pipeline uses the full ready task set for `pipeline:prd-<number>`. |
| R35 | Pipeline launch requires the selected PRD issue itself to be `open`; closed PRDs appear only in run history or completion evidence and cannot create a new run. |
| R36 | After Orca restarts, Pipeline must reconcile non-terminal runs before allowing replacement runs: reconnect still-live execution, or mark dead execution as `interrupted`, show a recovery report, expose dirty worktrees only for inspection, and require user acknowledgement before creating a new run. |
| R37 | If the parent PRD issue is closed while a Pipeline run is active, Pipeline waits until the next safe checkpoint, stops further planning/dispatch/merge/issue closure, marks the run `cancelled` with reason `prd_closed`, releases the reservation, and preserves worktrees/logs. |
| R38 | Pipeline must check that the parent PRD is still open before planner start, before each new planner iteration, before dispatching a worker batch, before review, before merge, before verify, and before issue closure. |
| R39 | Pipeline must not mutate task issue readiness labels when execution starts; Pipeline leaves `ready-for-agent` unchanged and treats GitHub issue closure as the task completion transition. |
| R40 | Pending recovery reports must appear as a blocking alert at the top of the matching PRD tab with an expandable recovery report panel; Pipeline must not use a global modal or app-wide popup for this flow. |
| R41 | Acknowledging a recovery report must only clear the replacement-run block; it must not automatically launch a new Pipeline run. |
| R42 | Acknowledged recovery reports must remain visible in the matching PRD tab as non-blocking history with expandable details. |
| R43 | The first replacement run created after an acknowledged recovery report must record the interrupted run and recovery report it replaces; later runs must not keep reusing the same recovery report link. |
| R44 | An interrupted run must remain `interrupted` forever; replacement run success must not rewrite the original run status. |
| R45 | If a replacement run is itself interrupted, Pipeline must create a new recovery report for that replacement run and allow the recovery chain to continue. |
| R46 | If multiple pending recovery reports exist for one PRD work set, Pipeline must use only the latest pending report as the blocking recovery report shown to the user. |
| R47 | Acknowledging the latest pending recovery report must not automatically change older non-latest pending recovery reports. |
| R48 | Older non-latest pending recovery reports must be labeled in history/detail UI as historical and non-blocking without adding a new database status. |
| R49 | v1 must not expose stage-level retry through RPC, CLI, or UI; failed stages are inspect-only and follow-up work starts through a new Pipeline run from current task truth. |

## Implementation Decisions

| ID | Decision | Reason |
| --- | --- | --- |
| D1 | Pipeline owns the Sandcastle-like lifecycle; Orchestration remains a generic task DAG dispatcher. | Keeps the coordinator reusable and avoids hiding planner/merge policy inside generic dispatch code. |
| D2 | Each planned task uses one managed worktree. | Best balance for user management, visible branches, terminal links, and agent context accuracy. |
| D3 | Orchestration should gain generic task execution metadata, not Pipeline-specific fields. | Pipeline can map tasks to worktrees without making Orchestration know about Pipeline semantics. |
| D4 | v1 supports multi-iteration runs. | Matches Sandcastle's useful behavior and avoids a redesign when dependencies are unlocked after merge. |
| D5 | Dynamic context execution is template-only. | Prevents prompt arguments, issue bodies, or user text from becoming shell commands. |
| D6 | GitHub task issues remain the task source of truth; Pipeline reuses Orca's Linear board only as a read-only display surface. | Avoids duplicated status editing and keeps task execution tied to the same issues created by the Matt skills. |
| D10 | Pipeline mode disables mutating Linear Tasks actions: drag status changes, new issue creation, direct workspace start, and inline issue editing. | Reuses existing Linear UI without letting Pipeline become a second task-management surface. |
| D7 | Pipeline execution targets are local and SSH only. | Matches Orca's existing user-operated runtime model and avoids GitHub Actions as a separate execution system. |
| D8 | Default Pipeline UI template is `parallel-planner-with-review`; `sequential-reviewer` is an explicit strict mode and is never auto-selected. | Preserves the original Pipeline goal while supporting Sandcastle's RALPH loop when the user wants one issue closed before the next starts. |
| D9 | `sequential-reviewer` always runs with `maxConcurrent = 1`. | Matches Sandcastle's sequential reviewer loop, where each outer iteration handles exactly one issue. |
| D11 | Pipeline PRD tabs own PRD work set selection, not single-run selection. | Users manage one PRD's task group while active and historical runs stay inside that PRD tab. |
| D12 | Pipeline PRD labels are derived exactly from PRD issue numbers. | Aligns with Matt/E2E PRD-to-task traceability while avoiding extra manual label decisions. |
| D13 | Recent Pipeline PRD tabs are persisted locally as UI shortcuts only. | Users can return to a PRD after restart without making tabs a second task status source. |
| D14 | Linear matching is explicit only. | Prevents unrelated Linear cards from appearing in a Pipeline PRD tab while still keeping GitHub-only task cards visible when Linear has no matching card. |
| D15 | The PRD task board represents remaining executable work, not historical completion. | Keeps the primary Pipeline UI focused on what can still run while preserving completed task evidence in run history. |
| D16 | Linear is optional for Pipeline UI. | GitHub issues and Pipeline DB already provide the task and runtime truth, so Linear should improve display but never block execution. |
| D17 | Pipeline UI displays local/SSH development context beside the PRD task board and locks execution target selection while a PRD work set has an active run. | Users need to know which Orca repo, branch pair, execution target, run, worktrees, and terminals are being used before trusting an automation run, without implying that switching targets bypasses the PRD work set reservation. |
| D18 | Pipeline launch starts from a smart PRD picker for one PRD work set, with manual PRD issue entry as an advanced fallback. | Most users should choose from recently generated Matt/E2E work instead of remembering issue numbers or labels. |
| D19 | PRD picker selects one PRD work set, not task groups or individual tasks. | Keeps Pipeline aligned with the full PRD ready task set and avoids reintroducing human task grouping, task ordering, or task selection. |
| D20 | Closed PRD issues are not launchable. | A closed PRD means the planning issue is no longer accepting new Pipeline work; historical runs still remain inspectable. |
| D21 | Restart recovery is inspect-first, not auto-resume. | Orca can restore UI tabs and reconnect live processes, but if execution died it must preserve evidence and require an explicit new run instead of silently continuing old work or automatically acting on dirty worktrees. |
| D22 | Runtime PRD closure is treated as cancellation, not interruption. | Closing a PRD is an intentional planning-state change, while `interrupted` is reserved for dead execution after restart. |
| D23 | PRD-open checks happen only at stage boundaries. | This avoids killing an agent mid-command while still preventing new planner, worker, review, merge, verify, or closure work after the PRD has been closed. |
| D24 | Pipeline does not add `in-progress` or `claimed` issue labels. | The active run reservation prevents duplicate Pipeline runs for one PRD work set; GitHub task completion remains the simple Sandcastle-style open/closed issue state, and rare external label edits are not a v1 control path. |
| D25 | Recovery prompts are PRD-tab-scoped. | Abnormal shutdown belongs to one PRD work set, so the user should see and acknowledge it where that PRD's run history, tasks, worktrees, and terminals are already visible. |
| D26 | Recovery acknowledgement and replacement launch are separate actions. | After reading the report, the user may still need to confirm the execution target, template, and current GitHub task state before starting another run. |
| D27 | Acknowledged recovery reports remain inspectable. | Users should be able to understand why a previous run became `interrupted` without keeping a resolved recovery report in a blocking state. |
| D28 | Replacement run lineage is stored on the replacement run. | The run history should show which interrupted run and recovery report led to the replacement without asking users to manage that link manually. |
| D29 | Interrupted status is immutable. | The old run's status records what actually happened; the replacement run is a separate execution record linked through lineage. |
| D30 | Recovery lineage can form a chain. | A replacement run can fail or be interrupted like any other run, so each interrupted run needs its own recovery report and optional direct replacement. |
| D31 | The latest pending recovery report is the only active recovery prompt. | Users should not have to resolve multiple abnormal-shutdown prompts before restarting work; the newest report is closest to current task truth. |
| D32 | Non-latest pending recovery reports are not auto-mutated. | They are abnormal history or diagnostic records, not extra workflow steps the user must clear before restarting. |
| D33 | Non-blocking recovery labels are UI-derived. | The database keeps the original `pending_ack` status, while the UI clarifies that non-latest pending reports no longer block launch. |
| D34 | Stage-level retry is out of v1. | A retry button would turn Pipeline into a manual stage manager; v1 keeps failed evidence inspectable and relies on replacement/new runs for follow-up. |

## Durable Docs

- Architecture: `docs/architecture/orca-pipeline-architecture.md`
- RPC and DB contract: `docs/contracts/pipeline-rpc-db.md`
- Template and prompt contract: `docs/contracts/pipeline-template-prompt.md`
- Testing and live verification: `docs/testing/pipeline-verification.md`
- Task slices: `docs/tasks/pipeline-task-slices.md`
