# Pipeline Task Slices

## Source

- PRD: `docs/prd/orca-sandcastle-like-pipeline.md`
- Architecture: `docs/architecture/orca-pipeline-architecture.md`
- Contracts:
  - `docs/contracts/pipeline-rpc-db.md`
  - `docs/contracts/pipeline-template-prompt.md`
- Testing: `docs/testing/pipeline-verification.md`

## Draft Slices

| Slice | Type | Blocked by | Requirement IDs | Contract IDs | Verification |
| --- | --- | --- | --- | --- | --- |
| S1 Setup PRD, contracts, and issue tracker | AFK | None | R1-R49 | all docs | Docs exist and issues link back. |
| S2 Add shared Pipeline types and DB schema | AFK | S1 | R3-R8, R11, R20-R21, R36, R43-R47 | C-DB-1..8, C-ST-1..5 | DB unit tests and migrations. |
| S3 Implement template registry, prompt renderer, and structured output parser | AFK | S2 | R3, R10 | C-OUT-1..6, C-PROMPT-1..5, C-SEC-1..8 | Unit tests T1-T3. |
| S4 Implement PRD-labeled GitHub task source and planner stage | AFK | S3 | R1-R4, R15, R17-R19, R35, R39 | C-RPC-2, C-BR-1..5, C-BR-13..17, C-BR-28, C-BR-34 | TaskSource tests and planner integration. |
| S5 Implement per-task worktree allocation and OrchestrationBridge | AFK | S4 | R4-R6, R39 | Generic orchestration execution context, C-DB-3, C-BR-34 | Integration tests IT1-IT4, IT38. |
| S6 Implement review, merge, verify, issue closure gate, and multi-iteration loop | AFK | S5 | R6-R8, R14, R22, R37-R39 | C-BR-6..11, C-BR-23..26, C-BR-32..34, C-ITER-1..6, C-ITER-8 | Integration tests IT6-IT10, IT14-IT16, IT36-IT38. |
| S7 Add Pipeline RPC and CLI commands | AFK | S6 | R12, R18, R20-R22, R27, R33-R49 | C-RPC-1..10, C-BR-16..41, C-ITER-7..8 | RPC and CLI tests. |
| S8 Add simplified Pipeline UI, read-only Linear Pipeline mode, smart PRD picker, PRD tabs, template selection, and Automation pipeline target | AFK | S7 | R9, R12-R13, R16-R17, R19-R21, R23-R49 | C-FE-1..30, Automation target design | UI tests and automation integration. |
| S9 Run full live verification and drift check | HITL | S8 | R14, R18-R49 | all contracts | Live scenarios L1-L45 and PR evidence. |

## Historical Published Issues

These issues were created for the first Pipeline implementation pass. They remain useful traceability, but current follow-up issues must include the PRD-labeled task source, active run reservation, and Sandcastle-style issue closure gate rules above.

| Slice | GitHub issue | Labels |
| --- | --- | --- |
| S1 | https://github.com/Nikolatesla-lj/orca/issues/3 | `task-slice`, `needs-triage` |
| S2 | https://github.com/Nikolatesla-lj/orca/issues/4 | `task-slice`, `needs-triage` |
| S3 | https://github.com/Nikolatesla-lj/orca/issues/5 | `task-slice`, `needs-triage` |
| S4 | https://github.com/Nikolatesla-lj/orca/issues/6 | `task-slice`, `needs-triage` |
| S5 | https://github.com/Nikolatesla-lj/orca/issues/7 | `task-slice`, `needs-triage` |
| S6 | https://github.com/Nikolatesla-lj/orca/issues/8 | `task-slice`, `needs-triage` |
| S7 | https://github.com/Nikolatesla-lj/orca/issues/9 | `task-slice`, `needs-triage` |
| S8 | https://github.com/Nikolatesla-lj/orca/issues/10 | `task-slice`, `needs-triage` |
| S9 | https://github.com/Nikolatesla-lj/orca/issues/11 | `task-slice`, `needs-triage` |

## Notes

- The published GitHub issues above are historical tracking records. A Pipeline execution queue must come from current open task-slice issues that match the frozen v1 contracts, not from closed historical issues.
- New task issues should start with `task-slice`, the default Pipeline PRD label `pipeline:prd-<PRD issue number>`, and `needs-triage`.
- Add the Pipeline PRD label while creating task-slice issues during `/e2e-slices` / `to-issues`. If an existing task is missing it, `/e2e-triage` must add it before marking the task Pipeline-runnable.
- Do not define alternate Pipeline task groups in v1; use exactly `pipeline:prd-<PRD issue number>`.
- `/e2e-triage` decides when a task becomes `ready-for-agent`.
- Pipeline runs only issues that are `open`, `task-slice`, `ready-for-agent`, and tagged with the run's Pipeline PRD label.
- Pipeline does not remove `ready-for-agent` or add `in-progress` / `claimed` when a task starts; active run reservation is the duplicate-run protection.
- The task issue must reference the expected PRD issue number before it can be included in a run.
- The parent PRD issue must be `open` before Pipeline can launch; closed PRDs are history-only.
- After Orca restarts, any non-terminal old run must be reconciled before a replacement run starts. Dead execution produces an `interrupted` run and a recovery report that the user must acknowledge.
- Recovery reports appear as a blocking alert at the top of the matching PRD tab with an expandable report panel, not as a global modal.
- Acknowledging a recovery report only enables replacement launch; it must not automatically start a new run.
- Acknowledged recovery reports remain visible as non-blocking PRD-tab history with expandable details.
- The first replacement run after recovery acknowledgement records `replacesRunId` and `recoveryReportId`; later runs must not reuse that recovery report link.
- Replaced runs remain `interrupted` forever; replacement success is shown by lineage, not by rewriting the old run status.
- If a replacement run is interrupted, it gets its own recovery report and the next replacement links to that new report, forming a recovery chain.
- If multiple pending recovery reports exist for one PRD work set, only the latest pending report blocks launch and appears as the top PRD-tab alert.
- Acknowledging the latest pending recovery report must not automatically change older non-latest pending reports.
- Older non-latest pending recovery reports should display as historical and non-blocking in history/detail UI without adding a new DB status.
- v1 must not expose stage-level retry through RPC, CLI, or UI; failed stages are inspect-only.
- If the parent PRD closes during an active run, Pipeline cancels at the next safe checkpoint with reason `prd_closed` and preserves worktrees/logs.
- PRD-open checkpoints run before planner start, before each new planner iteration, before worker dispatch, before review, before merge, before verify, and before issue closure.
- Implementation must not begin from this file alone; each task issue must include the Context Checklist and links above.

## Current PRD #13 Implementation Queue

The current post-freeze queue is tracked by PRD issue #13 with the runnable label
`pipeline:prd-13`. Issue #14 completed the first code-to-contract drift map in
`docs/tasks/pipeline-code-contract-drift-map.md`.

Follow-up implementation order and current local status:

1. #15: shared Pipeline types, DB schema, reservation, and recovery state. Complete locally.
2. #16: templates, prompt rendering, structured output, and GitHub PRD task source. Complete locally.
3. #17: run loop, OrchestrationBridge, worktrees, review, merge, and verify. Complete locally.
4. #18: issue closure gate, PRD-open checkpoints, and restart recovery. Complete locally.
5. #19: RPC, CLI, and Automation target surfaces. Complete locally.
6. #20: Pipeline UI, PRD tabs, read-only Linear mode, and recovery alerts. Complete locally.
7. #21: automated regression, live verification, and final drift evidence. Complete locally with recorded full-suite caveat.
