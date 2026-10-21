# Completed OMP agents still show active in Orca

Reported: 2026-10-01
Status: Confirmed worker status mismatch. This record describes the original investigation, not the current implementation.
Fix and current verification: [PR #24196](https://github.com/stablyai/orca/pull/24196).
Build observed during the test: `1.4.214-local.1790834225853.65731454c1c6`.
Runtime: `696fd1e3-312f-4b8d-8d92-35f422dbe46e`.

## User-visible failure

The user supplied two screenshots and reported that the main agent and a worker still showed in progress after both had completed. The screenshots are in the conversation, not copied into this repository. They must remain part of the issue evidence; this file does not claim to attach them.

Expected: After a turn and its background jobs complete, the agent status must show done. Sidebar and tab status must agree. Keeping an OMP process and terminal open must not by itself mean the agent is working.

## Live evidence

Run: `run_429bdaf8c24e`.

| Worker | Task                | Dispatch           | Result                            | Live status                                                                         |
| ------ | ------------------- | ------------------ | --------------------------------- | ----------------------------------------------------------------------------------- |
| A      | `task_5b92fcefe26b` | `ctx_0fdb3ba46a37` | `succeeded`; dispatch `completed` | `unavailable`; liveness `unverifiable`, reason `missing_status`; activity `unknown` |
| B      | `task_b8afdc8d5ccc` | `ctx_1320df23f4dc` | `succeeded`; dispatch `completed` | `fresh`; activity `done`; main-agent outcome `success`                              |

Worker A terminal: `term_a2263d24-1d7b-4f28-bc6e-b41f22abfa2c`.
Worker B terminal: `term_0a4c7fb2-76e0-470c-bd48-e7ffe7703e2b`.

Worker A's terminal screen showed:

- `LIVE_READY_PASS` after `sleep 20` completed.
- `BACKGROUND_JOB_PENDING` after an asynchronous `sleep 60` started.
- The background job completion notice.
- `BACKGROUND_JOB_FINISHED`, followed by the input prompt.

Thus, the worker had completed its later live probes as well as its original task. Terminal `status: running` means the OMP process remains open, not that it is still performing the task.

`orca worktree ps --json` exposed only worker B in the worktree's `agents` list, with `state: done`. The main agent and worker A were absent. The worktree reported `status: working` and `workspaceStatus: in-progress`.

Important limit: The main agent was running this investigation when that snapshot was taken. Its current working state is expected. That snapshot does not independently prove that the main agent was idle at the time of the user's screenshots. The reported stale main-agent status remains a user-observed failure; worker A's missing live status is independently confirmed.

## Earlier hook-delivery probe

A separate, now-closed diagnostic terminal completed a normal turn. Its canonical status-cache row was absent. `/new` restored its ready row, but the row was absent again after the next completed turn. The diagnostic extension reported HTTP `204` for `before_agent_start`, `agent_start`, `message_end`, and `agent_end`.

This shows that an HTTP acknowledgement does not prove that Orca retained and displayed the status row. It does not identify the exact path that removed or rejected the row.

## Source checks and cause limits

- `src/main/runtime/runtime-hook-agent-row-selection.ts`: fresh explicit status selection excludes restored-unconfirmed, identity-only, and stale observations.
- `src/main/runtime/runtime-worktree-agent-rows.ts`: fresh non-done rows contribute active status; completed worker B alone does not account for an active agent row.
- `src/main/agent-hooks/server/server-status-disposition.ts`: pane retirement and launch authority can suppress or restart status admission.
- `src/main/agent-hooks/server/server-cleanup.ts`: status rows can be removed by dismissal or pane cleanup.

[INFERENCE] The absent explicit status may leave another status source visible in the UI. Neither the removal path nor the UI fallback responsible for the screenshots has been established. Do not label this a renderer-only bug or a failed task.

## Reproduction and verification commands

1. Start two OMP workers through Orca. Complete both tasks and leave their terminals open.
2. In worker A, run a normal turn, then a background `sleep 60` turn. Let the job complete and the worker return to its input prompt.
3. Compare the terminal screen, worker result, live status, sidebar, and tab indicator.
4. Check whether a session reset restores the status row only until the next turn completes.

Commands exercised during this investigation:

```text
orca terminal read --terminal term_a2263d24-1d7b-4f28-bc6e-b41f22abfa2c --screen --json
orca orchestration worker-list --run run_429bdaf8c24e --json
orca worktree ps --json
```

No status was changed by hand. Both worker terminals were retained at the end of this investigation. No implementation changes or test runs were made during that investigation. Earlier automated test passes do not disprove the recorded live failure.

## Fix acceptance checks

- Both retained, completed workers expose explicit done status.
- The main agent shows done after its response ends; check it from a separate terminal to avoid starting a new main-agent turn.
- Sidebar and tab indicators agree with the explicit status.
- Normal turns, session reset, and background-job completion do not lose the live status row.
- Actual active work still shows working, and an open input dialog still shows waiting.
