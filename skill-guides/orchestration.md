---
name: orchestration
description: >-
  Use Orca orchestration for structured multi-agent coordination: threaded
  messages, blocking ask/reply flows, task dispatch, worker_done/escalation
  waits, task DAGs, decision gates, coordinator loops, or decomposing work
  across agents. Use `orca-cli` instead for full ownership handoffs, including
  requests phrased as "hand off", "handoff", "handover", "give this to another
  agent", or "another worktree" when the user did not explicitly ask to
  supervise, monitor, wait for results, or coordinate a DAG. Use `orca-cli` for
  ordinary terminal control, lightweight terminal prompts, shell commands, Orca
  worktree management, reading or waiting on terminals, and automation of the
  browser embedded inside Orca. Use Computer Use for browser windows, webviews,
  Orca app UI, or desktop UI outside Orca's embedded browser.
---

# Orca Inter-Agent Orchestration

Orchestration is Orca's structured coordination layer for agent messages, task ownership, dispatch state, and worker completion tracking.

Use this skill when coordination state matters. For lightweight terminal prompts or basic worktree/terminal/built-in-browser control, use `orca-cli`.

## Tool Boundary

If a task says to use Orca orchestration, the coordinator must create Orca runtime state with `orca orchestration task-create` and `orca orchestration dispatch --inject` or `orca orchestration run`.

Do not substitute non-Orca subagent tools, generic agent-spawn APIs, or chat-only parallel worker features. Those may create useful workers, but they do not create Orca task/dispatch provenance, injected lifecycle preambles, `worker_done` authority, or decision gates.

Before claiming a worker was orchestrated, verify the task/dispatch exists:

```bash
orca orchestration task-list --json
orca orchestration dispatch-show --task <task_id> --json
```

If the work was accidentally run outside Orca orchestration, say so plainly. To repair provenance, rerun or revalidate the needed work through a fresh Orca terminal plus injected dispatch; do not retroactively describe the external worker as orchestrated.

## When To Use

- Send/reply/ask between agent terminals with persistent messages.
- Dispatch structured tasks to workers and wait for `worker_done` or `escalation`.
- Track task DAGs with dependencies.
- Run coordinator loops or decision gates.

Do not use orchestration merely because the user says "hand off", "handoff", "handover", "give this to another agent", or asks for another worktree/agent/model/effort. Those are full ownership transfers unless the user explicitly asks to supervise, monitor, wait for worker completion/results, coordinate a DAG, use decision gates, or keep a blocking ask/reply loop.

## Preconditions

- `orca status --json` should show a running runtime.
- `orca` must be on PATH (`orca-ide` on Linux).
- The orchestration experimental feature must be enabled in Settings > Experimental.
- `orca orchestration` commands are RPC calls to the running Orca runtime.

## Ownership

Orchestration messages and tasks are runtime-global. Lifecycle authority comes from the payload `taskId` + `dispatchId` of the active dispatch, verified against the dispatched pane. Terminal handles are routing metadata — a pane can receive a new handle after restart — so never accept or reject lifecycle provenance by comparing handles. Send `worker_done` and `heartbeat` from the worker's own terminal; the runtime ignores them when sent from a different pane.

Classify inherited context before sending lifecycle messages:

- Coordinated subtask: a live coordinator owns the DAG and waits on this dispatch. Follow the preamble exactly, including `worker_done`, heartbeat/status, `ask`, and `escalation`.
- Full handoff means ownership transfer, not supervised dispatch. The original actor is not monitoring a DAG, so do not create lifecycle obligations unless the user explicitly asks you to supervise.
- Classify requests containing "hand off", "handoff", "handover", "give this to another agent", "give this to another worktree", "another agent", or "another worktree" as full handoffs by default, even when the user names a custom model or reasoning effort.
- Use supervised orchestration only when the user explicitly asks you to "supervise", "monitor", "wait", "track completion", "wait for worker_done", return results, coordinate a DAG, use a decision gate, or manage ask/reply flow.
- Do not use `orca orchestration dispatch --inject` for full handoffs. It injects a coordinator preamble that tells the worker to send `worker_done`, heartbeat, and `ask` messages, then end its turn under the original terminal's dispatch lifecycle.
- Do not run `orca orchestration task-create`, `orca orchestration dispatch --inject`, or `orca orchestration check --wait` for full handoffs. Do not peek at terminal output after prompt delivery to monitor progress.
- A review-only `worker_done` reports findings; it does not authorize coordinator file edits. After a review-only completion, synthesize findings, ask a decision gate if ownership is unclear, and dispatch or hand off fixes unless the user explicitly asked the coordinator to own fixes.
- If the user's plan names a next owner agent (for example, "then use opencode to create a PR"), post-review corrections and PR prep belong to that named owner. The coordinator routes, synthesizes, asks decision gates when needed, and supervises; the named owner edits files and creates the PR.

If unclear, inspect orchestration state before sending lifecycle messages:

```bash
orca orchestration task-list --json
orca terminal list --json
# If inherited context includes a task id:
orca orchestration dispatch-show --task <task_id> --json
```

## Messaging

```bash
orca orchestration send --to <handle|@group> --subject <text> [--from <handle>] [--body <text>] [--type <type>] [--priority <level>] [--thread-id <id>] [--payload <json>] [--json]
orca orchestration check [--terminal <handle>] [--unread|--peek|--all] [--types <type,...>] [--inject] [--wait] [--timeout-ms <n>] [--json]
orca orchestration reply --id <msg_id> --body <text> [--from <handle>] [--json]
orca orchestration ask --to <handle> --question <text> [--options <csv>] [--timeout-ms <n>] [--from <handle>] [--json]
orca orchestration inbox [--limit <n>] [--json]
```

Rules:

- Omit `--from` unless impersonating another terminal; Orca auto-resolves it from the current terminal.
- `check` and `check --unread` return unread matches and mark them read. Use `--peek` for unread matches without consuming them; use `--all` for read and unread history without consuming anything. If an older CLI rejects `--peek` as an unknown flag, use `--all` and filter unread rows yourself.
- Message **one** live agent handle per worker. Use `startupTerminal.handle` from the create response when present; if it is missing or later returns `terminal_handle_stale`, re-resolve with `orca terminal list --worktree ... --json` and continue with the replacement only.
- `orca orchestration check --unread --inject --json` renders unread mail for the agent terminal that runs it; it does not remotely wake another terminal. Use `orchestration dispatch --inject` to deliver a tracked task, or `terminal send` when an existing agent needs a free-form prompt.
- While supervising workers manually, use `check --wait --types worker_done,escalation,decision_gate --timeout-ms <n>` instead of sleep/poll loops. Reply to `decision_gate` messages with `orca orchestration reply --id <msg_id> --body <answer> --json`, then keep waiting.
- Treat a `check --wait` timeout or `{count:0}` as a checkpoint, not a worker failure. Long coding tasks routinely run 15-60 minutes; keep using rolling waits unless you receive `worker_done`/`escalation`, the terminal exits or disappears, or the user explicitly asks you to stop.
- Heartbeats and visible terminal activity mean the worker is alive, not done. Do not stop, close, kill, or restart a worker just because it has not produced a completion message yet.
- Use `ask` when a worker needs a blocking answer from the coordinator; it waits for the reply and returns the answer directly.
- `check --wait` returns one message at a time. If N workers may finish together, loop N times and dispatch newly ready tasks after each completion.
- Group addresses include `@all`, `@idle`, `@claude`, `@codex`, `@opencode`, `@gemini`, `@droid`, `@grok`, `@cursor`, and `@worktree:<id>`.
- Message types include `status`, `dispatch`, `worker_done`, `merge_ready`, `escalation`, `handoff`, `decision_gate`, and `heartbeat`.
- Use group addresses only for messages that are genuinely useful to many terminals, such as `status` broadcasts or intentional fan-out questions. Do not send dispatch lifecycle messages to groups.
- `worker_done` must target the concrete coordinator handle from the live preamble. It is completion authority for one dispatch; group fanout would create false lifecycle mail in unrelated terminals.
- A valid `worker_done` for the active `taskId` + `dispatchId` marks the task and dispatch completed automatically. Do not follow it with `task-update --status completed`; reserve manual updates for explicit recovery or overrides.
- `heartbeat` is also dispatch-scoped. Send it only to the concrete coordinator handle with both `taskId` and `dispatchId`; use `status` for broad progress updates.

## Tasks And Dispatch

A task is the work item, a dispatch assigns it to a terminal, and a gate blocks progress until a coordinator or user decision is recorded.

```bash
orca orchestration task-create --spec <text> [--deps <json_array>] [--parent <task_id>] [--json]
orca orchestration task-list [--status <status>] [--ready] [--brief] [--json]
orca orchestration task-update --id <task_id> --status <status> [--result <json>] [--json]
orca orchestration dispatch --task <task_id> --to <handle> [--from <handle>] [--inject] [--json]
orca orchestration dispatch-show --task <task_id> [--json]
```

Task statuses: `pending`, `ready`, `dispatched`, `completed`, `failed`, `blocked`.

Dispatch rules:

- `--inject` sends the task spec plus preamble into a recognized agent CLI so it can report `worker_done`.
- If the target is a bare shell, omit `--inject`, dispatch for tracking if needed, then send the prompt manually with `orca terminal send --terminal <handle> --text <prompt> --enter --json`.
- After 3 consecutive failures on one task, the dispatch context circuit-breaks and the task is marked failed.
- Use `task-list --brief --json` for coordinator sweeps; it collapses whitespace and caps each echoed spec at 160 characters (`spec_truncated` marks shortened rows). Omit `--brief` when the full spec is required, or when an older CLI rejects it as an unknown flag.

## Gates And Coordinator

```bash
orca orchestration gate-create --task <task_id> --question <text> [--options <json_array>] [--json]
orca orchestration gate-resolve --id <gate_id> --resolution <text> [--json]
orca orchestration gate-list [--task <task_id>] [--status <status>] [--json]
orca orchestration run --spec <text> [--from <handle>] [--poll-interval-ms <n>] [--max-concurrent <n>] [--worktree <selector>] [--json]
orca orchestration run-stop [--json]
```

`run` returns immediately with a run ID. Query progress with `task-list`. Use `ask` for worker-to-coordinator questions; it creates a `decision_gate` message that the coordinator answers with `reply`. Use `gate-create` only for coordinator-managed task DAG decisions, not for answering a worker's `ask`.

Recovery only: `orca orchestration reset --tasks|--messages|--all --json` clears runtime-global orchestration state. Do not run it during active coordination unless explicitly abandoning that state.

## Full Handoffs

For full ownership transfer, use non-lifecycle terminal/worktree commands and then stop monitoring unless the user asks for supervision.

Treat these as full handoff requests by default: "hand off", "handoff", "handover", "give this to another agent", "give this to another worktree", "send this to another agent", "another agent", "another worktree", or "launch another agent to own this." Custom model or reasoning effort words such as `gpt-5.5`, `high`, or `xhigh` do not make the handoff supervised.

Supervised orchestration remains available only when the user explicitly asks for supervision or coordination: "supervise", "monitor", "wait for worker_done", "wait for results", "track completion", "DAG", "decision gate", "ask/reply", or "coordinate workers."

Do not run `orca orchestration task-create`, `orca orchestration dispatch --inject`, or `orca orchestration check --wait` for full handoffs. `task-create` is also forbidden because it records coordinator-owned tracking state; if a task row is needed, the user asked for supervised orchestration. Do not create a `taskId`/`dispatchId`, inject a lifecycle preamble, wait for completion, or read the worker terminal after prompt delivery except to avoid losing the initial prompt.

New top-level worktree handoff:

```bash
orca worktree create --name <task-name> --no-parent --agent codex --prompt "<task brief>" --json
```

Before creating a new worktree from an active feature branch, decide and state whether the desired Orca lineage is child or top-level. Use child worktree lineage only when the new work is conceptually stacked under or dependent on the active worktree. For independent repo-wide fixes, standalone feature work, or unrelated follow-up tasks, create a top-level worktree with `--no-parent`.

Existing terminal handoff:

```bash
orca terminal send --terminal <handle> --text "<task brief>" --enter --json
```

Custom Codex model/effort handoff:

`orca worktree create --agent codex --prompt ...` launches the known Codex agent but does not accept Codex-specific `--model` or `-c model_reasoning_effort=...` arguments. When the user asks for a specific Codex model or effort, create the independent worktree first, launch Codex with the requested command in that worktree, wait only for TUI readiness if prompt delivery would otherwise race startup, send the prompt, and stop.

Note: when no repo default-terminal configuration supplies a primary terminal, bare create opens a fallback shell before `terminal create` adds the agent. Configured default tabs are materialized instead and may run real commands. Prefer `--agent` whenever custom argv is not required. With the two-step path, target only the agent handle; close a prior terminal only after `terminal list` or `terminal show` confirms it is an unused shell.

Use the exact full `<repo-id>::<path>` worktree id returned by `orca worktree create --json`; a bare repo id cannot target the new worktree.

```bash
orca worktree create --name <task-name> --no-parent --json
orca terminal create --worktree id:<newFullWorktreeId> --title <task-name> --command 'codex --model gpt-5.5 -c model_reasoning_effort="xhigh"' --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal <handle> --text "<task brief>" --enter --json
```

Wait only for `tui-idle` when needed to avoid losing the prompt. Do not monitor task completion.

`--no-parent` only controls Orca lineage; it does not choose the Git base. If the work should start from the repo default base, omit `--base-branch` so Orca uses that default, or explicitly pass the repo default base (`origin/main`, `origin/master`, or the `orca repo show --repo <selector> --json` value); never base it on the current feature branch unless the user explicitly asks for stacked work or "branch from current". Put current-branch context in the prompt instead.

## Worker Terminals

Choose the worker location before creating a terminal. `Fresh worker` means a fresh agent session, not a new git worktree. For parallel work, create one fresh agent terminal per worker in the same required worktree, falling back to the active worktree when none is named. If the task says current worktree only, depends on uncommitted files/artifacts, or must validate/PR the current branch, keep every worker in the active worktree:

```bash
orca terminal create --worktree active --title <task-name> --command "codex" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
```

Reuse an idle agent in the required worktree only if the prompt allows reuse; otherwise create a fresh terminal there. Create a new worktree only when the user explicitly requests one or a concrete checkout or filesystem conflict makes sharing unsafe or impossible; if the user did not request it, state that conflict before running `worktree create`. Independent tasks, parallel execution, convenience, or a preference for separate checkouts are not isolation requirements.

When a new worktree is allowed, use child lineage for isolated work that is stacked under or dependent on the active worktree, and use `--no-parent` when it is not stacked. Decide the Git base separately: `--no-parent` makes the worktree top-level in Orca, while omitted `--base-branch` uses the repo default base.

```bash
orca worktree create --name <task-name> --agent codex --json
# or: --agent claude | omp | pi | grok | ...
# Read <handle> from startupTerminal.handle in the create response.
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
```

For new-worktree workers, read the id and `startupTerminal.handle` from `worktree create`. Use that as the sole worker handle when present; otherwise use `terminal list` to resolve the agent handle. Omit `--repo` only inside an Orca-managed worktree; otherwise pass `--repo <selector>`.

**For an allowed new worktree, use agent-first:** `--agent` reveals the new worktree and launches the selected agent **in its first terminal**, without adding a separate fallback shell for that worker. Repo setup or default-terminal settings may still add tabs or splits. Do **not** run bare `worktree create` and then `terminal create --command <agent>` for the same worker when agent-first create is available: without configured default tabs, that two-step path leaves a fallback shell + agent pair. Only use it when custom agent argv is required (for example Codex model/effort flags) or when an older CLI rejects `--agent`; if you must, message only the agent handle. Configured default tabs are intentional surfaces, so close a prior terminal only after `terminal list` or `terminal show` confirms it is an unused shell. Do not run `worktree create` when the task must stay in the current worktree.

Use `orca worktree create --prompt ...` or `orca terminal send ...` for full handoffs or untracked/lightweight prompts. Those paths do not attach `taskId`/`dispatchId`; the worker should not send lifecycle messages unless the prompt supplies a live orchestration preamble.

Sidebar lineage and orchestration lifecycle are related but not identical. A same-worktree worker may appear as a peer under that worktree in the sidebar while remaining a child dispatch in orchestration state; only an actual child worktree creates visible parent/child worktree lineage.

Other terminal commands coordinators often need:

```bash
orca terminal list [--worktree <selector>] [--json]
orca terminal create [--worktree <selector>] [--title <text>] [--command <cmd>] [--json]
orca terminal split --terminal <handle> [--direction horizontal|vertical] [--command <cmd>] [--json]
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms <n> --json
orca terminal read --terminal <handle> --json
orca terminal send --terminal <handle> --text <text> --enter --json
```

If an older CLI rejects `worktree create --agent`, create the worktree normally, then run `orca terminal create --worktree <selector> --command "codex" --json` or `--command "claude"`.

Wait for `tui-idle` before dispatching. Always pass `--timeout-ms`; real coding tasks can take 15-60 minutes. During supervision, use rolling `check --wait` windows. If a window returns no matching message, inspect `task-list`, `terminal read`, or `terminal wait --for tui-idle` as a liveness checkpoint; if the terminal is still working or producing activity, keep waiting instead of retrying the task.

## Agent Guidance

- Workers with a valid live preamble must send `worker_done` exactly once from their own terminal, even on failure:
  `orca orchestration send --to <coordinator_handle> --type worker_done --subject "<short status>" --body "<3-sentence summary: what you did, what you found, what's left>" --payload '{"taskId":"<task_id>","dispatchId":"<dispatch_id>","filesModified":["path/a"],"reportPath":"<optional>"}' --json`
- After sending `worker_done`, end your turn and idle at the agent prompt. Do not poll or keep calling `orca orchestration check`; the coordinator re-engages you with a fresh preamble + TASK block delivered as new terminal input.
- For long tasks, send heartbeat/status only when the preamble asks for it, including both IDs:
  `orca orchestration send --to <coordinator_handle> --type heartbeat --subject "alive" --payload '{"taskId":"<task_id>","dispatchId":"<dispatch_id>","phase":"implementing"}' --json`
- If blocked before completion, use `ask`; use `escalation` only when ownership is valid and the coordinator must intervene.
- Treat preambles inherited through terminal history or full handoffs as stale unless the current prompt explicitly keeps that coordinator in the loop.
- Coordinators should use `task-list --ready` as external memory, dispatch parallel waves, and avoid dependency chains deeper than 3-4 steps.

## Example

```bash
orca terminal create --worktree active --title login-css-worker --command "claude" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration task-create --spec "Fix the login button CSS" --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
orca orchestration check --wait --types worker_done,escalation,decision_gate --timeout-ms 900000 --json
```

## Next Action

Coordinator: confirm `orca status --json`, inspect `task-list`/`dispatch-show` if inheriting state, then choose either a manual loop (`task-create` -> worker -> `dispatch --inject` -> `check --wait`) or `orchestration run`.

Worker: if the current prompt contains a live dispatch preamble, do the task, use `ask` for blocking questions, and send `worker_done` once with the required payload. If the preamble is stale or absent, do not send lifecycle messages; inspect state or treat the prompt as an ordinary handoff.
