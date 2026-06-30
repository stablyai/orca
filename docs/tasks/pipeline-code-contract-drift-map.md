# Pipeline Code-to-Contract Drift Map

## Source

- Task issue: https://github.com/Nikolatesla-lj/orca/issues/14
- Parent PRD issue: https://github.com/Nikolatesla-lj/orca/issues/13
- PRD label: `pipeline:prd-13`
- Frozen PRD: `docs/prd/orca-sandcastle-like-pipeline.md`
- RPC/DB contract: `docs/contracts/pipeline-rpc-db.md`
- Template/prompt contract: `docs/contracts/pipeline-template-prompt.md`
- Architecture: `docs/architecture/orca-pipeline-architecture.md`
- Testing plan: `docs/testing/pipeline-verification.md`

## Scope Decision

This pass is a drift check and implementation map only. It does not reopen Pipeline v1
product design and does not add runtime behavior.

No new GitHub Actions execution, manual task-source acceptance path, alternate PRD work
set grouping, user task hand-picking, force rerun, or stage-level retry behavior is
introduced by this document.

## Current Code Baseline

The local implementation now covers the frozen Pipeline v1 follow-up queue through
#21. The implementation remains uncommitted in this worktree.

Implemented:

- Shared Pipeline run, iteration, task, stage, log, and dynamic-context types.
- SQLite tables for runs, iterations, tasks, stages, logs, dynamic context, active
  run reservations, and recovery reports.
- Built-in `parallel-planner-with-review` and `sequential-reviewer` templates.
- Structured planner output parsing from the last `<plan>...</plan>` block.
- Prompt rendering with built-in arg protection and dynamic-context command recording.
- Public Pipeline run input limited to GitHub PRD task sources with `prdIssueNumber`,
  exact derived `pipeline:prd-N`, and `state=open`.
- GitHub parent PRD open validation and task filtering by `task-slice`,
  `ready-for-agent`, exact Pipeline PRD label, open state, and PRD body reference.
- Planner stage, task record creation, branch collision detection.
- Generic Orchestration task execution context and worktree selector mapping.
- Runtime executor that creates planner/task/merge worktrees, runs coordinator,
  reviews branches with commits, merges, verifies, and loops by iteration stop reason.
- PRD-open checkpoints before planner, iteration, dispatch, review, merge, verify,
  and issue closure work; closed parent PRD cancels with `status_reason=prd_closed`.
- Issue closure gate after verify; GitHub issue tasks are not marked verified until
  GitHub reports the task issue as closed.
- Active run reservation per PRD work set with explicit stale release.
- Interrupted recovery report, acknowledgement, and one-time replacement lineage state.
- RPC/CLI methods for `templateList`, `run`, `list`, `show`, `cancel`, `logs`,
  `releaseStaleReservation`, `prdCandidates`, `recoveryReportList`, and
  `recoveryReportAcknowledge`.
- Automation target union for `pipeline` and AutomationService direct Pipeline dispatch.
- Automations Pipeline UI with smart PRD picker, PRD tab keying, GitHub-only task
  preview, local/SSH target display, recovery alert/acknowledgement, recovery
  history, and read-only run detail.

Known remaining verification caveat:

- Full Vitest has unrelated failures in pre-existing shell-ready and relay git-handler
  tests. The Pipeline target suite, typecheck, lint, CLI build, and Electron/Vite
  build pass; details are recorded in the testing section below.

## Technology Stack Confirmation

| Area | Existing choice | Decision for follow-up slices |
| --- | --- | --- |
| Language/runtime | TypeScript, Electron main/renderer, Node CLI | Keep existing stack. |
| Package/build | pnpm, Vite/Electron Vite, tsgo/tsc, Vitest | Keep existing commands and tests. |
| Frontend | React, shadcn primitives, STYLEGUIDE tokens | Follow existing Automations page patterns and `docs/STYLEGUIDE.md`. |
| API | Runtime RPC method registry in `src/main/runtime/rpc/methods` | Add Pipeline RPCs through the same registry. |
| Data | SQLite via `src/main/pipelines/PipelineDb` and existing persistence integration | Extend Pipeline schema in DB layer; do not add a new database product. |
| Task source | GitHub CLI/API patterns already exist in repo; current Pipeline uses `gh` shell commands | Follow existing GitHub provider compatibility rules and fork issue tracker rules. |
| Execution | Local/SSH runtime, managed worktrees, terminal/coordinator infrastructure | Keep local/SSH only; no GitHub Actions. |
| Tests | Vitest unit/integration plus CLI/runtime tests; live verification by CLI/UI | Extend current Pipeline tests before final live pass. |

## Drift Summary By Follow-up Issue

| Follow-up | Owns | Current status | Main drift to close |
| --- | --- | --- | --- |
| #15 | Shared types, DB, reservation, recovery state | Implemented | No code drift found in targeted verification. |
| #16 | Templates, prompt rendering, structured output, GitHub PRD task source | Implemented | Public launch path now requires GitHub PRD source and exact derived label. |
| #17 | Run loop, OrchestrationBridge, worktrees, review, merge, verify | Implemented | Review/merge/verify path is covered by Pipeline tests. |
| #18 | Issue closure gate, PRD-open checkpoints, restart recovery | Implemented | Closure gate, `prd_closed`, recovery acknowledgement, and replacement lineage are covered by tests. |
| #19 | RPC, CLI, Automation target surfaces | Implemented | C-RPC-1..10 and public CLI shape are covered by tests; no retry-stage command is exposed. |
| #20 | UI, PRD tabs, Linear read-only mode, recovery alerts | Implemented | PRD picker/tab state, sequential concurrency, and recovery launch blocker are covered by UI state tests. |
| #21 | Final automated and live verification | Implemented with caveat | Automated target checks pass; full-suite non-Pipeline failures are recorded as residual risk. |

## Requirement Coverage

| Requirement group | Required frozen behavior | Current code evidence | Status | Follow-up |
| --- | --- | --- | --- | --- |
| R1-R4 | Consume prepared PRD tasks, parse planner output, create Pipeline and Orchestration tasks before coordinator | `task-source.ts`, `structured-output.ts`, `planner-stage.ts`, `planner-task-records.ts`, `orchestration-bridge.ts` | Match | #16, #17 |
| R5-R7 | Per-task worktrees, implement/review in task branch, merge/verify in merge worktree | `runtime-executor.ts`, `runtime-executor-implement-stages.ts`, `orchestration-bridge.ts`, `review-merge-verify.ts` | Match | #17 |
| R8 | Multi-iteration with template/default max iterations | `iteration-loop.ts` and runtime executor iteration tests | Match | #17 |
| R9, R13 | Automation can trigger Pipeline and link usage/run history | `AutomationTarget`, `AutomationService`, `usage-collector.ts`, automation RPC/CLI tests | Match | #19 |
| R10 | Dynamic context commands come only from template raw text and are bounded | `prompt-renderer.ts`, `dynamic-context-command-runner.ts`, dynamic context DB records | Match | #16 |
| R11 | Persistent inspectable run history | Pipeline DB run/iteration/task/stage/log/context/reservation/recovery tables | Match | #15, #18 |
| R12 | UI/CLI expose template list, run, list, show, cancel, logs and recovery helpers | Pipeline RPC/CLI methods C-RPC-1..10 | Match | #19, #20 |
| R14 | Completion evidence includes tests, live verification, drift, traceability | This drift map and `docs/testing/pipeline-verification.md` | Match with caveat | #21 |
| R15, R17-R19, R27, R33-R35 | PRD issue input, exact derived label, full ready task set, smart PRD picker, no task narrowing, empty preflight reject, closed PRD reject | Shared PRD work-set helper, task source, CLI flags, RPC schema, UI state | Match | #16, #19, #20 |
| R16, R25-R32 | PRD tabs, read-only Linear board, GitHub-only fallback, development context | `PipelinePanel.tsx`, `PipelineLaunchCard.tsx`, `PipelineRunDetailPane.tsx`, `pipeline-panel-state.ts` | Match | #20 |
| R20-R21 | Active run reservation and conflict/stale release UX | `pipeline_active_run_reservations`, service launch blocker, release RPC/CLI/UI state | Match | #15, #19, #20 |
| R22-R24 | Closure gate and sequential reviewer strict mode | `sequential-reviewer`, forced `maxConcurrent=1`, `issue-closure-gate.ts` | Match | #16, #18 |
| R36-R48 | Restart recovery, interrupted status, acknowledgement, replacement lineage, latest pending report behavior | `pipeline_recovery_reports`, recovery DB/service/RPC/UI state tests | Match | #15, #18, #20 |
| R37-R39 | PRD-open checkpoints and readiness-label immutability | `prd-open-checkpoint.ts`, runtime checkpoints, task-source open/label filters without label mutation | Match | #16, #18 |
| R40-R49 | Recovery alert/history and failed-stage inspect-only, no stage retry | Recovery UI state, run detail inspect-only behavior, CLI/RPC specs without retry-stage | Match | #20, #21 |

All PRD requirements R1-R49 are covered by the rows above and mapped to one or more
follow-up issues.

## Contract Drift

### C-RPC

| Contract | Current code | Status | Follow-up |
| --- | --- | --- | --- |
| C-RPC-1 `pipelines.templateList` | Implemented in `PIPELINE_METHODS` and CLI | Match | #19 regression |
| C-RPC-2 `pipelines.run` | Implemented with public GitHub PRD task source, derived label validation, reservation gate, and recovery gate | Match | #16, #18, #19 |
| C-RPC-3 `pipelines.list` | Implemented | Match | #19 regression |
| C-RPC-4 `pipelines.show` | Implemented with runs/iterations/tasks/stages/logs/dynamic context and lineage fields | Match | #15, #18, #19 |
| C-RPC-5 `pipelines.cancel` | Implemented and releases active reservation for terminal cancelled runs | Match | #18, #19 |
| C-RPC-6 `pipelines.logs` | Implemented | Match | #19 regression |
| C-RPC-7 `pipelines.releaseStaleReservation` | Implemented in service/RPC/CLI | Match | #15, #19 |
| C-RPC-8 `pipelines.prdCandidates` | Implemented in service/RPC/CLI/UI candidate loading | Match | #19, #20 |
| C-RPC-9 `pipelines.recoveryReportList` | Implemented in service/RPC/CLI/UI recovery loading | Match | #15, #18, #19 |
| C-RPC-10 `pipelines.recoveryReportAcknowledge` | Implemented in service/RPC/CLI/UI acknowledgement | Match | #15, #18, #19 |

### C-DB And C-ST

| Contract | Current code | Status | Follow-up |
| --- | --- | --- | --- |
| C-DB-1 `pipeline_runs` | Stores `status_reason`, `interrupted`, `replaces_run_id`, `recovery_report_id`, and terminal-state immutability | Match | #15 |
| C-DB-2 `pipeline_iterations` | Supports `interrupted` and terminal-state updates | Match | #15 |
| C-DB-3 `pipeline_tasks` | Supports `interrupted` and `issue_closure_json` | Match | #15, #18 |
| C-DB-4 `pipeline_stages` | Supports `interrupted` and recovery-aware status updates | Match | #15, #18 |
| C-DB-5 `pipeline_logs` | Exists | Match for append-only log baseline | #15 regression |
| C-DB-6 `pipeline_dynamic_context_results` | Exists and records command results | Match | #16 regression |
| C-DB-7 `pipeline_active_run_reservations` | Implemented | Match | #15 |
| C-DB-8 `pipeline_recovery_reports` | Implemented | Match | #15 |
| C-ST-1..4 | Run/iteration/task/stage statuses include `interrupted` and terminal immutability | Match | #15 |
| C-ST-5 | Recovery report status and acknowledgement | Match | #15, #18 |

### C-OUT, C-PROMPT, C-SEC, C-TPL

| Contract | Current code | Status | Follow-up |
| --- | --- | --- | --- |
| C-OUT-1..6 | Last `<plan>` wins, JSON fences, parse/schema failure, context error fields | Match | #16 regression |
| C-PROMPT-1..5 | Missing args, built-in override, inline args, user dynamic context injection covered; unused args warn | Match | #16 |
| C-PROMPT-6..7 | Task source provides close command text and runtime verifies closure through the closure gate | Match | #16, #18 |
| C-SEC-1..6 | Raw shell block marking, timeout, exit failure, truncation and recording exist | Match | #16 regression |
| C-SEC-7..8 | Runtime cwd is the stage worktree and command results are recorded | Match | #16, #17 |
| C-TPL-1 | `parallel-planner-with-review` is the default built-in template | Match | #16 regression |
| C-TPL-2..6 | `sequential-reviewer`, no auto-switching, forced concurrency | Match | #16, #19, #20 |

### C-BR

| Rule group | Status | Main gap | Follow-up |
| --- | --- | --- | --- |
| C-BR-1 | Match | Empty PRD task source is rejected before execution. | #16 |
| C-BR-2..4 | Match | Parser errors and branch collision are covered. | #16 regression |
| C-BR-5 | Match | Dependencies are mapped through OrchestrationBridge and tested. | #17 |
| C-BR-6..10 | Match | No-commit skip, merge failure, verify failure, and closure gate failure are covered. | #17, #18 |
| C-BR-11..12 | Match | Iteration stop/cancel and reservation release are covered. | #17, #18 |
| C-BR-13..17, C-BR-27..28, C-BR-34 | Match | Public task source is PRD-scoped GitHub only, with open PRD validation and no user task narrowing. | #16, #19 |
| C-BR-18..22 | Match | Active reservation and stale release behavior are implemented. | #15, #19, #20 |
| C-BR-23..26 | Match | Issue closure gate and sequential reviewer strict mode are implemented. | #16, #18 |
| C-BR-29..40 | Match | Recovery report, acknowledgement, replacement lineage, and latest-pending behavior are implemented. | #15, #18, #20 |
| C-BR-32..33 | Match | PRD-open checkpoints and `prd_closed` cancellation are implemented. | #18 |
| C-BR-41 | Match | No retry-stage RPC/CLI/UI operation is exposed. | #19, #20, #21 |

### C-ITER

| Contract | Current code | Status | Follow-up |
| --- | --- | --- | --- |
| C-ITER-1..6 | `iteration-loop.ts` implements empty plan, no progress, max iterations, failure, cancellation, continue-after-progress | Match | #17 |
| C-ITER-7 | Startup reconciliation to interrupted + recovery report | Match | #18 |
| C-ITER-8 | Parent PRD closed checkpoint cancellation | Match | #18 |

### C-FE

| Contract group | Current code | Status | Follow-up |
| --- | --- | --- | --- |
| C-FE-1..4 | Template list, run history/detail, cancel action exist in Pipeline UI | Match | #20 |
| C-FE-5..19 | Read-only Linear mode, task preview, PRD tabs, label derivation, smart PRD picker, GitHub-only fallback, development context | Match | #20 |
| C-FE-20..30 | Recovery gate/alert/history/lineage/failed-stage inspect-only display | Match | #20 |

## Current Issue Queue Check

PRD #13 follow-up issues carrying `pipeline:prd-13`:

| Issue | Role | Local implementation status | Drift owner |
| --- | --- | --- | --- |
| #14 | S1 drift check | Complete before this pass | This document |
| #15 | S2 shared types/DB/reservation/recovery | Complete before this pass | C-DB, C-ST, C-BR recovery/reservation base |
| #16 | S3 template/prompt/task source | Complete in this worktree | C-OUT, C-PROMPT, C-SEC, C-TPL, GitHub PRD task source |
| #17 | S4 run loop/orchestration/worktrees/review/merge/verify | Complete in this worktree | C-ITER-1..6, C-BR-4..12 |
| #18 | S5 closure/checkpoints/recovery | Complete in this worktree | C-BR-23..41, C-ITER-7..8 |
| #19 | S6 RPC/CLI/Automation | Complete in this worktree | C-RPC-1..10, public CLI contract |
| #20 | S7 UI | Complete in this worktree | C-FE-1..30 |
| #21 | S8 final verification | Complete with recorded caveat | Full automated/live/drift evidence |

The local code and docs are ready for review as one uncommitted change set. GitHub issue
closure should wait for repository review/merge policy rather than being inferred from
this uncommitted workspace alone.

## Test And Live Evidence Drift

Current useful evidence:

- Pipeline unit/integration tests cover parser, prompt renderer, task source, DB,
  reservation/recovery state, planner stage, orchestration bridge, runtime executor,
  review/merge/verify, issue closure gate, PRD-open cancellation, RPC, CLI,
  Automation target, and Pipeline UI state.
- `docs/testing/pipeline-verification.md` records the historical local runtime smoke
  run plus the current automated verification run.
- GitNexus was re-indexed after adding the new Pipeline files and can resolve
  `PipelineService` from `src/main/pipelines/service.ts`.

Current evidence caveats:

- Full Vitest still has seven unrelated failures in pre-existing shell-ready and
  relay git-handler tests. They are outside the Pipeline changed files and are recorded
  below.
- Current GitHub PRD issue live execution against #13/#16-#21 was not run in this
  session. The acceptance proof for this pass is automated target coverage plus the
  historical local runtime smoke run.

## Drift Check Result For Issue #14

- PRD issue still matches implementation intent: match.
- Task issue Context Checklist: match.
- Frozen docs are internally usable for follow-up slices: match.
- Current code matches the frozen v1 contracts covered by #15-#21: match, with the
  verification caveats recorded above.
- Follow-up implementation order: completed as #15 -> #16 -> #17 -> #18 -> #19 -> #20 -> #21.
- Mock usage: none added in this task.
- Live verification: not applicable for this slice by issue #14.
- Code changes: none required by this slice.

## Post-Issue #15 Update

Issue #15 has now implemented the shared Pipeline type and persistence base that the
drift map assigned to it:

- `PipelineRunStatus`, `PipelineIterationStatus`, `PipelineTaskStatus`, and
  `PipelineStageStatus` now include `interrupted`.
- `pipeline_runs` now stores `status_reason`, `replaces_run_id`, and
  `recovery_report_id`.
- `pipeline_tasks` now stores `issue_closure_json`.
- `pipeline_active_run_reservations` and `pipeline_recovery_reports` now exist.
- Pipeline DB exposes active reservation creation/lookup/release/refresh.
- Pipeline DB exposes recovery report creation/list/latest-pending lookup,
  acknowledgement, and replacement-run lineage.
- Pipeline terminal statuses are immutable in DB update paths, including replaced
  interrupted runs.

The remaining #15-era drift was closed by the #16-#21 implementation pass below.

## Post-Issue #16-#21 Update

Issues #16 through #21 have now been implemented locally:

- #16: Public Pipeline task source now requires GitHub PRD input, validates the exact
  derived `pipeline:prd-N` label, checks the parent PRD is open, filters only open
  ready task-slice issues for that PRD, and includes the `sequential-reviewer` template
  with forced concurrency of `1`.
- #17: Runtime execution now keeps Pipeline planning, task creation, Orchestration
  dispatch, worktree creation, review, merge, verify, and iteration progression wired
  through the frozen contracts.
- #18: Issue closure gate, PRD-open checkpoints, `prd_closed` cancellation, active
  reservation release, recovery acknowledgement, and replacement lineage are implemented.
- #19: RPC and CLI expose C-RPC-1..10 only; public CLI launch derives the Pipeline PRD
  label from `--prd-issue` and no retry-stage command is exposed.
- #20: Automations Pipeline UI now uses PRD candidates/tabs, GitHub-only task preview,
  run detail, local/SSH target context, sequential concurrency handling, recovery
  alerts, acknowledgement, and recovery history.
- #21: Automated verification, build verification, GitNexus re-indexing, and this final
  drift update were completed. Full-suite non-Pipeline failures remain recorded risk.
