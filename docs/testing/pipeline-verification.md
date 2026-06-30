# Pipeline Testing and Live Verification Plan

## Source

- PRD: `docs/prd/orca-sandcastle-like-pipeline.md`
- Architecture: `docs/architecture/orca-pipeline-architecture.md`
- RPC and DB contract: `docs/contracts/pipeline-rpc-db.md`
- Template and prompt contract: `docs/contracts/pipeline-template-prompt.md`

## Unit Tests

| ID | Target | Coverage |
| --- | --- | --- |
| T1 | `PipelineStructuredOutput` | Last tag wins, code fence JSON, missing tag, invalid JSON, schema failure, raw output summary. |
| T2 | `PipelinePromptRenderer` | Missing args, built-in override rejection, unused arg warning, inline prompt arg rejection, dynamic context marker safety. |
| T3 | `PipelineTemplateRegistry` | Built-in template listing, versioning, invalid template rejection. |
| T4 | `PipelineDb` | Schema creation, migrations, run/iteration/task/stage/log/reservation/recovery-report CRUD, replacement lineage fields, terminal status immutability, cancellation and interrupted transitions. |
| T5 | `PipelineService` | Status transitions, launch preflight, active run reservation, startup reconciliation, recovery report gate, latest pending recovery selection, non-latest pending preservation, PRD closure checkpoints, multi-iteration loop, max-iteration stop. |
| T6 | `TaskSource` | GitHub issue parsing, open PRD validation, `task-slice` + `ready-for-agent` + Pipeline PRD label filters, PRD parent validation, readiness-label immutability, malformed issue handling. |
| T7 | `OrchestrationBridge` | Planner output -> orchestration.taskCreate, dependency mapping, task execution context mapping. |
| T8 | `WorktreeLauncher` | Deterministic branch names, linked issue metadata, SSH/runtime-safe selector propagation. |
| T9 | `ReviewMergeVerify runners` | Skip review on no commits, merge conflict failure, verify command failure, log capture. |
| T10 | `PipelinePanel` | Smart PRD picker, PRD launch form, `pipeline:prd-N` derivation, default `parallel-planner-with-review`, explicit `sequential-reviewer`, hidden concurrency control in sequential mode, empty task preview blocking, PRD tabs not split by local/SSH target, recent PRD tab persistence, PRD board filtering, GitHub-only board fallback, Orca development context panel with read-only execution target during active runs, PRD-tab recovery alert, acknowledgement gate, latest pending recovery prompt, non-latest pending recovery history, non-blocking pending recovery labels, separated replacement launch, acknowledged recovery history, replacement lineage display, replaced interrupted run display, recovery chain display, inspect-only failed stages, reused Linear board Pipeline mode, reservation conflict actions. |
| T11 | `IssueClosureGate` | `CLOSE_TASK_COMMAND` rendering, prompt-owned issue closure, and task completion only after GitHub issue is closed. |

## Integration Tests

| ID | Flow | Evidence |
| --- | --- | --- |
| IT1 | Planner output creates Pipeline Tasks and Orchestration tasks. | DB rows and task IDs linked. |
| IT2 | Task deps promote ready tasks after dependencies complete. | Orchestration task statuses. |
| IT3 | Per-task worktree selector dispatches worker to the correct worktree. | Terminal/worktree IDs match task rows. |
| IT4 | Worker `worker_done` completes task and Pipeline records commits from git inspection. | Task stage and commit rows. |
| IT5 | Failed worker records Pipeline failure without losing logs. | Failed stage, preserved worktree. |
| IT6 | Reviewer runs in same task worktree only when commits exist. | Review stage rows and git diff. |
| IT7 | Merger receives only branches with commits. | Merge prompt args and merge worktree log. |
| IT8 | Verify commands run after merge and fail the run on non-zero exit. | Verify stage command result. |
| IT9 | Automation target creates a Pipeline Run and links automation run history. | AutomationRun contains PipelineRun link. |
| IT10 | Multi-iteration run re-plans after merge and stops on empty plan or max iterations. | Iteration rows and planner outputs. |
| IT11 | Duplicate launch for the same PRD work set is rejected inside one Orca runtime. | Existing run id is returned and no second planner starts, even when the second launch selects a different local/SSH execution target. |
| IT12 | Terminal run status releases active run reservation. | Completed/failed/cancelled run releases reservation in final-state transaction. |
| IT13 | Stale reservation requires explicit confirmation. | Release is rejected without confirmation and allowed only after stale criteria are met. |
| IT14 | Parallel merger closes merged issues with `CLOSE_TASK_COMMAND`. | Issue closure result is recorded and next planner snapshot no longer sees closed tasks. |
| IT15 | RALPH-style sequential loop closes one issue before the next issue starts. | Iteration 2 starts only after iteration 1 issue is closed. |
| IT16 | Closure-capable stage finishes but issue remains open. | Task is not treated as complete and dependent/later planner work does not advance. |
| IT17 | Pipeline UI default template is parallel planner. | Launch input uses `parallel-planner-with-review` unless user explicitly selects another template. |
| IT18 | Sequential reviewer strict mode runs one issue at a time. | Second issue execution starts only after first issue is closed. |
| IT19 | Template choice is not auto-switched. | Task count, dependencies, failures, and PRD work set size do not change the selected template. |
| IT20 | Sequential reviewer forces single concurrency. | UI hides concurrency input and RPC/CLI input resolves `maxConcurrent` to `1`. |
| IT21 | Linear Tasks board runs in read-only Pipeline mode. | Drag status changes, new issue creation, inline editing, and Start workspace are unavailable; open-source-page and Pipeline detail actions remain. |
| IT22 | Pipeline board filters to selected PRD work set. | Unmatched Linear cards are hidden, matched cards get Pipeline overlay, and PRD GitHub tasks without Linear matches remain visible as GitHub-only cards. |
| IT23 | Pipeline PRD tabs switch selected PRD work set. | Switching tabs changes task board, active run, run history, and reservation context without mixing PRDs; changing local/SSH target does not create another tab for the same PRD work set. |
| IT24 | PRD issue derives exact Pipeline PRD label. | UI and CLI derive `pipeline:prd-<number>` from the PRD issue number. |
| IT25 | Recent PRD tabs restore after restart. | Restored tabs appear for the same repo/provider/PRD work set and immediately refresh task/run data instead of trusting cached status. |
| IT26 | Linear cards require explicit GitHub task match. | Cards with a GitHub issue URL or issue number in external links, description, or title receive Pipeline overlay; unmatched cards are hidden. |
| IT27 | PRD task board hides closed tasks. | Closed PRD task issues are absent from the main board and remain visible through run history/task detail completion evidence. |
| IT28 | Pipeline UI works without Linear. | With Linear disconnected or unavailable, the selected PRD work set still renders GitHub-only task cards and run launch remains available. |
| IT29 | Orca development context is visible. | Selected PRD work set/run shows execution target, repo/worktree identity, source branch, target branch, active run, and available worktree/terminal links; execution target selection is read-only while an active run owns the PRD work set reservation. |
| IT30 | Smart PRD picker chooses a PRD candidate. | Recent PRD candidates load from GitHub and Pipeline records, selecting one fills PRD input, derives `pipeline:prd-N`, and preview uses the full PRD ready task set. |
| IT31 | Smart PRD picker cannot narrow tasks or define alternate task groups. | Candidate selection exposes no per-task checkboxes, issue exclusions, drag sorting, or individual issue-number list; submitted input uses only the derived Pipeline PRD label. |
| IT32 | Closed PRD cannot launch a Pipeline run. | Smart PRD picker omits closed PRDs, and manual PRD issue entry for a closed PRD fails before task listing or planner launch. |
| IT33 | Startup reconnects live non-terminal runs. | If terminal/coordinator/stage processes are still alive after app restart, Pipeline preserves the reservation, reconnects monitoring, and does not create a replacement run. |
| IT34 | Startup marks dead non-terminal runs interrupted. | If execution processes are gone, Pipeline writes a recovery report, marks old run/iteration/task/stage rows `interrupted`, releases the reservation, and blocks replacement launch until acknowledgement. |
| IT35 | Acknowledged recovery enables explicit replacement launch from current task truth. | Acknowledging the latest recovery report does not create a run; a second explicit launch creates a new run from current open PRD ready tasks without resuming old terminals, auto-merging preserved worktrees, or auto-closing issues. |
| IT36 | Active run stops at checkpoint when parent PRD closes. | Closing the parent PRD during execution does not immediately kill the current stage, but the next checkpoint marks the run `cancelled` with reason `prd_closed`, releases the reservation, and starts no new planner/worker/merge/closure work. |
| IT37 | PRD-open checks cover every stage boundary. | Simulate a closed parent PRD before planner start, before a new planner iteration, before worker dispatch, before review, before merge, before verify, and before issue closure; each case cancels with `prd_closed` before starting that next stage. |
| IT38 | Pipeline does not claim task issues by label mutation. | Starting planner, worker dispatch, review, merge, or verify never removes `ready-for-agent` and never adds `in-progress` or `claimed`; Pipeline completion is determined by the issue closure gate. |
| IT39 | Recovery report prompt is PRD-tab-scoped. | A pending recovery report renders a blocking alert at the top of the matching PRD tab with an expandable report panel, blocks only replacement launch for that PRD work set, and does not open a global modal or app-wide popup. |
| IT40 | Recovery acknowledgement does not auto-start a run. | Acknowledging a pending recovery report clears the blocking alert and enables launch controls without calling `pipelines.run`; only the user's next explicit launch creates a replacement run. |
| IT41 | Acknowledged recovery report remains inspectable. | After acknowledgement, the report moves to non-blocking PRD-tab history with expandable details and launch controls remain enabled. |
| IT42 | Replacement run records recovery lineage once. | The first run launched after acknowledging a recovery report stores `replacesRunId` and `recoveryReportId`; later runs for the same PRD work set do not reuse that recovery report link. |
| IT43 | Replaced interrupted run status stays interrupted. | When a replacement run completes successfully, the original run status remains `interrupted`; UI and CLI show any follow-up only through replacement lineage. |
| IT44 | Replacement run interruption creates a new recovery report. | If a replacement run is interrupted, startup reconciliation creates a new recovery report for that replacement run and the next replacement links to that new report, forming a chain without mutating older runs. |
| IT45 | Multiple pending recovery reports show only latest blocker. | Given multiple pending reports for one PRD work set, launch is blocked only by the latest pending report and the PRD-tab alert shows only that latest report. |
| IT46 | Acknowledging latest pending report leaves older pending reports unchanged. | Given multiple pending reports, acknowledging the latest report enables launch and leaves older non-latest pending reports in `pending_ack` without creating additional blocking alerts. |
| IT47 | Non-latest pending reports show historical non-blocking label. | Older non-latest `pending_ack` reports render in history/detail as historical and non-blocking while their stored status remains `pending_ack`. |
| IT48 | Stage-level retry is not exposed in v1. | RPC methods, CLI help, and failed-stage UI expose no retry-stage operation; failed stages remain inspect-only. |

## Live Verification

Prepare a small disposable repo or fixture branch with:

1. Three GitHub issues in `Nikolatesla-lj/orca` labeled `task-slice`, `ready-for-agent`, and the PRD's Pipeline PRD label such as `pipeline:prd-2`.
2. Each task issue references the expected parent PRD issue number.
3. Two independent tasks.
4. One task that depends on a change made by another task.
5. A simple test command that can pass and fail deterministically.

Run:

```bash
orca pipelines run \
  --template parallel-planner-with-review \
  --repo <repo-id> \
  --task-source github \
  --task-repo Nikolatesla-lj/orca \
  --prd-issue 2 \
  --base main \
  --max-concurrent 2 \
  --max-iterations 2
```

Verify:

| ID | Scenario | Expected result | Evidence |
| --- | --- | --- | --- |
| L1 | Start a Pipeline Run from CLI. | Run is created and visible in CLI list/show. | CLI output. |
| L2 | Planner selects unblocked tasks. | First iteration creates only runnable tasks. | Planner output and DB rows. |
| L3 | Workers run in separate worktrees. | Each task has its own worktree card and branch. | UI screenshot or CLI show. |
| L4 | Review runs after commits. | Reviewer terminal is linked to same task worktree. | Stage detail. |
| L5 | Merge combines completed branches. | Merge worktree contains successful branches only. | Git log and merge stage log. |
| L6 | Verify runs configured commands. | Verify stage records command output and status. | Pipeline logs. |
| L7 | Second iteration re-plans. | Newly unblocked task runs in iteration 2. | Iteration rows. |
| L8 | Cancel preserves worktrees. | Cancelled run keeps task worktrees inspectable. | UI/CLI worktree list. |
| L9 | Automation target launches Pipeline. | Automation run links to Pipeline run. | Automation history. |
| L10 | Failure is inspectable. | Failed stage shows task, terminal, raw output summary, and worktree. | UI/CLI show output. |
| L11 | Duplicate PRD launch is blocked. | Second run for the same PRD work set returns the owning run, even if the second launch chooses a different local/SSH execution target. | CLI/UI conflict output. |
| L12 | Terminal status releases reservation. | Re-running the same PRD work set after completed/failed/cancelled is allowed; interrupted runs release the reservation but require recovery report acknowledgement before replacement launch. | Reservation row and CLI output. |
| L13 | Stale reservation release is explicit. | Release appears only after stale criteria and requires confirmation. | UI/CLI confirmation evidence. |
| L14 | Template closes successful task issues. | After merge/test verification, `CLOSE_TASK_COMMAND` closes merged task issues. | GitHub issue state and Pipeline task closure record. |
| L15 | Closure gate blocks unfinished tasks. | If the closure-capable stage does not close an issue, later planner work does not treat it as complete. | GitHub issue state and Pipeline logs. |
| L16 | Default UI launch uses parallel planner. | Starting from UI without changing template uses `parallel-planner-with-review`. | UI run detail and template id. |
| L17 | RALPH strict mode closes before next issue. | Sequential template closes issue 1 before issue 2 begins. | GitHub issue states and iteration logs. |
| L18 | Template remains user-selected. | Re-running the same PRD work set with different task counts keeps the selected template unchanged. | UI run detail and template id. |
| L19 | RALPH mode has no user concurrency setting. | Sequential run records `maxConcurrent = 1` and UI does not show the concurrency control. | UI screenshot/run detail. |
| L20 | Pipeline reuses Linear board in read-only mode. | Existing Linear board view is visible with Pipeline status overlay and mutating actions disabled. | UI screenshot and interaction checks. |
| L21 | Board shows only selected PRD work set. | Unrelated Linear cards are absent; current PRD tasks remain visible. | UI screenshot and task ids. |
| L22 | Pipeline PRD tabs isolate task groups. | Switching between two PRD tabs changes task set, active run, run history, and status overlay correctly; local/SSH changes do not create duplicate tabs for one PRD work set. | UI screenshot, PRD ids, and run ids. |
| L23 | PRD issue derives exact Pipeline PRD label. | Selecting or entering PRD issue `2` uses `pipeline:prd-2`. | UI screenshot and CLI/run input. |
| L24 | PRD tabs survive restart. | Recent Pipeline PRD tabs restore after app restart and refreshed data matches GitHub/Pipeline DB state. | Restarted app screenshot and refreshed run/task ids. |
| L25 | Linear matching hides unrelated cards. | Only Linear cards explicitly linked to current PRD GitHub tasks appear; unrelated board cards are absent. | UI screenshot and matched issue ids. |
| L26 | Closed tasks move out of the board. | After a task issue is closed, the PRD board no longer shows it, while run history still shows closure evidence. | UI screenshot, GitHub issue state, and run detail. |
| L27 | Pipeline works without Linear connection. | Disconnect Linear and confirm the PRD GitHub-only board still displays runnable tasks and can launch a run. | UI screenshot and run id. |
| L28 | Local/SSH Orca development context is visible. | PRD tab shows the selected execution target, repo/worktree identity, source/target branches, active run, and worktree/terminal links; target selection is editable before launch and read-only during an active run. | UI screenshot and run detail links. |
| L29 | User launches from smart PRD picker. | A recently generated PRD candidate is selected without typing manually, preview shows the full ready task set for `pipeline:prd-N`, and launch creates the run. | UI screenshot, selected PRD label, and run id. |
| L30 | PRD picker does not hand-pick tasks or define alternate task groups. | The picker can select only a PRD work set; individual task inclusion and order are absent from the UI, and submitted input uses only the derived Pipeline PRD label. | UI screenshot and submitted run input. |
| L31 | Closed PRD is history-only. | Close a PRD issue, confirm it is absent from launch candidates, and manual launch by PRD issue number is rejected before task listing. | UI/CLI rejection, GitHub PRD issue state, and no new run row. |
| L32 | Restart recovery report gates replacement run. | Kill Orca during an active run, restart with execution gone, confirm the old run is `interrupted`, recovery report shows completed/open tasks plus preserved/dirty worktrees, dirty worktree actions are inspect-only, replacement launch is rejected until acknowledgement, acknowledgement alone creates no run, then a separate launch starts from current open PRD ready tasks. | Recovery report, run statuses, reservation row, UI/CLI acknowledgement, no-run-after-ack evidence, and new run id after explicit launch. |
| L33 | Closing PRD during active run cancels at checkpoint. | Close the parent PRD while a stage is running, confirm the current stage reaches a boundary, no new stage starts, the run is `cancelled` with reason `prd_closed`, reservation is released, and worktrees/logs remain inspectable. | GitHub PRD state, run detail, reservation row, stage list, and preserved worktree/log evidence. |
| L34 | PRD-open checkpoint coverage is visible. | Close the parent PRD before a planned next stage and confirm the stage list shows cancellation before the next planner, worker, review, merge, verify, or issue-closure stage starts. | GitHub PRD state, stage timeline, run `status_reason`, and absence of the blocked next stage. |
| L35 | Task issue readiness labels stay unchanged during execution. | Start a Pipeline run and inspect a selected task issue while it is executing; `ready-for-agent` remains present and no `in-progress` or `claimed` label is added. After closure, the issue disappears from the runnable board because it is closed. | GitHub issue labels before/during execution, run detail, and closed issue state after completion. |
| L36 | Abnormal shutdown warning appears in the PRD tab. | Kill Orca during an active run, restart with execution gone, open the matching PRD tab, and confirm the top blocking alert plus expandable recovery report panel appears there without a global modal. | PRD tab screenshot, recovery report id, blocked launch state, and absence of global modal. |
| L37 | Recovery acknowledgement is not launch. | Click the recovery report acknowledgement action and confirm the alert clears, launch controls become available, and no new run row appears until the user explicitly starts a replacement run. | UI screenshot, recovery report status, run count before/after acknowledgement, and run id after explicit launch. |
| L38 | Acknowledged recovery report is history. | After acknowledgement, confirm the report remains visible in the PRD tab history/detail area, no longer blocks launch, and can still be expanded to inspect worktrees, terminal status, issue state, and logs. | UI screenshot, report status, launch enabled state, and expanded report details. |
| L39 | Replacement run links to interrupted run and recovery report. | After acknowledging a recovery report and launching a replacement run, confirm the replacement run detail links back to the interrupted run and recovery report; launch another normal run later and confirm it does not reuse the old recovery report link. | Replacement run detail, interrupted run link, recovery report link, and later run detail without stale recovery link. |
| L40 | Interrupted run remains interrupted after replacement succeeds. | Complete the replacement run and confirm the original run still shows `interrupted`, with only a follow-up link to the replacement run. | Original run detail, replacement run detail, run history screenshot, and CLI show output. |
| L41 | Recovery chain continues after replacement interruption. | Interrupt a replacement run, restart, confirm a new recovery report is created for that replacement run, acknowledge it, launch a second replacement, and confirm the chain shows A interrupted -> B interrupted replacement -> C replacement. | Run history screenshot, recovery reports, lineage links, and CLI show output. |
| L42 | Only latest pending recovery report blocks launch. | Seed or produce multiple pending reports for one PRD work set, open the PRD tab, confirm only the latest pending report appears as the blocking alert, acknowledge it, and confirm launch controls enable without processing older pending reports. | PRD tab screenshot, report timestamps/ids, blocked launch state, acknowledgement result, and launch enabled state. |
| L43 | Older pending reports are not auto-changed. | With multiple pending reports, acknowledge the latest one and confirm older pending reports keep their original status while no longer blocking launch or creating top alerts. | Recovery report list before/after acknowledgement, PRD tab screenshot, launch enabled state, and older report statuses. |
| L44 | Older pending reports are visibly non-blocking. | Open history/detail for older non-latest pending reports and confirm they show a historical/non-blocking label while the backend still reports `pending_ack`. | UI screenshot, backend report status, and launch enabled state. |
| L45 | Failed stage has no retry-stage action. | Force a stage failure, open run detail and CLI help, and confirm evidence links are available but no retry-stage RPC/CLI/UI action is exposed. | Run detail screenshot, CLI help output, RPC method list or dispatch check, and preserved logs/worktree. |

The current live verification target is the PRD-labeled GitHub issue path above. Manual task input is not a final acceptance path.

## Historical Live Verification Run: 2026-06-05

Environment:

- Runtime id: `9aee5763-2ea7-4293-a11f-a1648ca372ce`
- Disposable live root: `/tmp/orca-pipeline-live-20260605-clean`
- Repo id: `fc49d123-0c6c-48ba-bfc2-4bbff4baeb95`
- Agent path: fake `codex` override at `/tmp/orca-pipeline-live-20260605-clean/fake-bin/codex`
- Entry point: `node out/cli/index.js` over runtime-bound WebSocket pairing.

| ID | Status | Evidence |
| --- | --- | --- |
| L1 | pass | CLI `pipelines run/list/show/logs` created and inspected `pipe_run_447eafcf019d`; final status `completed`. |
| L2 | pass | `pipe_run_447eafcf019d` iteration 1 planner output selected `manual-1`; iteration rows and task rows were written. |
| L3 | pass | Worker ran in managed worktree `.../workspaces/repo/Pipeline-smoke-task` with implement terminal `term_62767561-7b7c-4d04-8d94-0ef11bb4fe45`. |
| L4 | pass | Review stage completed in the same task worktree with terminal `term_5085d684-9d16-41bf-b1d8-1439a103252c`. |
| L5 | pass | Merge stage completed in `.../workspaces/repo/Pipeline-merge-1` with terminal `term_41609f0b-d5ea-4d8a-bc87-9cec347e059c`; task recorded one commit. |
| L6 | pass | Verify command `test -f pipeline-smoke.txt` exited `0`, `timedOut=false`, and was recorded in dynamic context results. |
| L7 | pass | `pipe_run_447eafcf019d` advanced to iteration 2, planner output was `{ "issues": [] }`, and the run stopped as `completed`. |
| L8 | pass | `pipe_run_9fa17391fe41` was cancelled while `verifying`; final status `cancelled`. `worktree list` still showed planner, task, and merge worktrees for inspection. |
| L9 | pass | CLI created pipeline target automation `b14cf857-5fb9-49f2-a413-f1312568e096`; manual automation run linked `pipelineRunId=pipe_run_af31ba9b8b6d`, and that Pipeline run completed. |
| L10 | pass | `pipe_run_59d9f5faaa3e` failed on verify command `test -f definitely-missing.txt`; `pipelines show/logs` exposed failed verify stage, exit code `1`, merge worktree id, and error log. |

Captured live evidence files:

- `/tmp/orca-pipeline-live-20260605-clean/show-success-final.json`
- `/tmp/orca-pipeline-live-20260605-clean/cancel-after.json`
- `/tmp/orca-pipeline-live-20260605-clean/cancel-worktrees.json`
- `/tmp/orca-pipeline-live-20260605-clean/automation-create.json`
- `/tmp/orca-pipeline-live-20260605-clean/automation-run.json`
- `/tmp/orca-pipeline-live-20260605-clean/automation-runs.json`
- `/tmp/orca-pipeline-live-20260605-clean/automation-pipeline-show-final.json`
- `/tmp/orca-pipeline-live-20260605-clean/failure-show-final.json`
- `/tmp/orca-pipeline-live-20260605-clean/failure-logs.json`

Drift result:

- The previous live-runner blocker is resolved for local runtime execution.
- `pipelines.run/show/logs/cancel` match the RPC/DB contract.
- Automation target integration now has a real CLI/RPC path and live evidence.
- Cancellation preserves worktrees; failure details remain inspectable.
- This run used the earlier manual smoke path. It remains useful regression evidence, but it is not sufficient for the current PRD-labeled GitHub task-source acceptance target.

## Automated Verification Run: 2026-06-06

Passed:

- `pnpm run typecheck`
- `pnpm run lint`
  - Passed with existing `ChecksPanel.tsx` React hook dependency warnings.
- `pnpm exec vitest run --config config/vitest.config.ts src/main/pipelines/*.test.ts src/main/runtime/rpc/methods/pipelines.test.ts src/main/runtime/rpc/methods/automations.test.ts src/cli/handlers/pipelines.test.ts src/cli/index.test.ts src/main/persistence.test.ts src/main/automations/service.test.ts src/main/runtime/orca-runtime-automations.test.ts src/renderer/src/components/automations/pipeline-panel-state.test.ts src/renderer/src/components/automations/automation-run-view-state.test.ts src/renderer/src/components/automations/automation-usage-model.test.ts src/renderer/src/lib/automation-session-reuse.test.ts`
  - 26 files passed, 399 tests passed.
- `pnpm run build:cli`
  - Passed; `/usr/local/bin/orca-dev` symlink install reported permission denied and exited `0`.
- `pnpm run build:electron-vite`
  - Passed with existing Vite dynamic/static import warnings.
- `npx gitnexus analyze --force`
  - Passed; final run reported 76,891 nodes, 142,771 edges, 2,274 clusters, and 300 flows.
- `npx gitnexus status`
  - Passed; index status was up-to-date.
- `gitnexus_detect_changes(scope=all)`
  - Completed with medium risk, 131 changed symbols, 34 tracked changed files, and three affected AutomationsPage processes.
- `gitnexus_context(PipelineService)`
  - Confirmed the new `src/main/pipelines/service.ts` symbol is indexed, covering the untracked Pipeline source files.

Full-suite result:

- `pnpm test`
  - 1346 files passed, 4 failed, 3 skipped.
  - 13565 tests passed, 7 failed, 53 skipped.
  - Failures are outside the Pipeline changed files:
    - `src/relay/git-handler.test.ts`: expected `/not a git repository/i`, got `Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).`
    - `src/relay/pty-shell-launch.test.ts`: 2 OSC marker lifecycle count failures.
    - `src/main/daemon/shell-ready.test.ts`: 2 OSC marker lifecycle count failures.
    - `src/main/providers/local-pty-shell-ready.test.ts`: 2 OSC marker lifecycle count failures.

Current drift result:

- #16 through #21 implementation paths are covered by targeted automated tests.
- Full-suite failures are recorded as residual non-Pipeline blockers.
- A current live run against GitHub PRD #13 was not executed in this session; the historical local runtime smoke run remains the live-runtime evidence.

## Automated Verification Run: 2026-06-05

Passed:

- `pnpm exec vitest run --config config/vitest.config.ts src/main/pipelines/*.test.ts src/main/runtime/rpc/methods/pipelines.test.ts src/main/runtime/rpc/methods/automations.test.ts src/cli/handlers/pipelines.test.ts src/cli/index.test.ts src/main/persistence.test.ts src/main/automations/service.test.ts src/main/runtime/orca-runtime-automations.test.ts src/renderer/src/components/automations/pipeline-panel-state.test.ts src/renderer/src/components/automations/automation-run-view-state.test.ts src/renderer/src/components/automations/automation-usage-model.test.ts src/renderer/src/lib/automation-session-reuse.test.ts`
  - 25 files passed, 381 tests passed.
- `pnpm run typecheck`
- `pnpm run lint`
  - Passed with existing `ChecksPanel.tsx` React hook dependency warnings.
- `pnpm run build:cli`
  - Passed; `/usr/local/bin/orca-dev` symlink install still reports permission denied and exits `0`.
- `pnpm run build:electron-vite`

Full-suite result:

- `pnpm test`
  - 1345 files passed, 4 failed, 3 skipped.
  - 13547 tests passed, 7 failed, 53 skipped.
  - Failures are non-Pipeline blockers already observed before this final pass:
    - `src/relay/git-handler.test.ts`: expected `/not a git repository/i`, got `Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).`
    - `src/relay/pty-shell-launch.test.ts`: 2 OSC marker lifecycle count failures.
    - `src/main/daemon/shell-ready.test.ts`: 2 OSC marker lifecycle count failures.
    - `src/main/providers/local-pty-shell-ready.test.ts`: 2 OSC marker lifecycle count failures.

## Full Comprehensive Suite

Before completing the Pipeline phase or PR:

- Static checks: repo lint command.
- Type checks: repo typecheck command.
- Unit tests: Pipeline, OrchestrationBridge, prompt renderer, structured output, DB.
- Integration tests: Pipeline run with local git fixture.
- UI tests: Pipeline page or Automations target controls when UI is implemented.
- CLI tests: template-list, run, list, show, cancel, logs.
- Live verification: L1-L45 above.
- Drift check:
  - `docs/contracts/pipeline-rpc-db.md` matches code.
  - `docs/contracts/pipeline-template-prompt.md` matches templates and renderer.
  - `docs/architecture/orca-pipeline-architecture.md` matches ownership boundaries.
  - GitHub task issues match implemented acceptance criteria.

## Mock Policy

Allowed:

- Mock GitHub API in unit tests for `TaskSource`.
- Mock terminal/runtime in unit tests for dispatch and stage runners.
- Mock command runner for dynamic context timeout and non-zero exit tests.

Required real-path proof:

- Integration test must use a real local git repo fixture.
- Final acceptance must prove the PRD-labeled GitHub issue source path.
- Live verification must use real managed worktrees and real terminal launches.
- Verify stage must execute at least one real command in the merge worktree.
