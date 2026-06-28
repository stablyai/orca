---
name: orchestration
description: >-
  Use Orca orchestration for structured multi-agent coordination: threaded
  messages, blocking ask/reply flows, task dispatch, worker_done/escalation
  waits, task DAGs, decision gates, coordinator loops, or decomposing work
  across agents. Use `orca-cli` instead for full ownership handoffs, ordinary
  terminal control, lightweight terminal prompts, shell commands, Orca worktree
  management, reading or waiting on terminals, and automation of the browser
  embedded inside Orca. Use Computer Use for browser windows, webviews, Orca app
  UI, or desktop UI outside Orca's embedded browser. Also triggers on the compact
  shortcuts `/orchestration review <agents>`, `/orchestration oracle <agents>`,
  and `/orchestration handoff <agent>` for fanning out a code review, getting a
  second opinion, or handing the current work to another agent (see Recognized
  Shortcuts).
---

# Orca Inter-Agent Orchestration

Orchestration is Orca's structured coordination layer for agent messages, task ownership, dispatch state, and worker completion tracking.

Use this skill when coordination state matters. For lightweight terminal prompts or basic worktree/terminal/built-in-browser control, use `orca-cli`.

## When To Use

- Send/reply/ask between agent terminals with persistent messages.
- Dispatch structured tasks to workers and wait for `worker_done` or `escalation`.
- Track task DAGs with dependencies.
- Run coordinator loops or decision gates.
- Run a compact shortcut: `/orchestration review <agents>`, `/orchestration oracle <agents>`, or `/orchestration handoff <agent>` (see Recognized Shortcuts).

## Preconditions

- `orca status --json` should show a running runtime.
- `orca` must be on PATH (`orca-ide` on Linux).
- The orchestration experimental feature must be enabled in Settings > Experimental.
- `orca orchestration` commands are RPC calls to the running Orca runtime.

## Recognized Shortcuts

These three verbs are an optional fast-path — a compact phrasing for orchestration moves you can already trigger with a full natural-language prompt. Natural-language orchestration still works exactly as before; the shortcuts add shorthand, they do not replace it. Each acts on the current task/branch in the active worktree, and each maps onto the lower-level commands documented later in this skill.

Grammar: `/orchestration <verb> <agents>`, where `<verb>` is `review`, `oracle`, or `handoff`. `<agents>` is one or more agent names from the catalog, delimited by a comma or `and` (e.g. `/orchestration oracle cursor and claude`). Agents are always named explicitly — there is no `all agents` form. `review` and `oracle` accept one or more agents; `handoff` takes a single agent. If a named agent cannot be launched or never reports back within the wait window, surface it as unavailable/incomplete in the result — best-effort; do not hang indefinitely or silently drop it.

### `review <agents>` and `oracle <agents>` — ephemeral children

`review` fans out a code review of the current changes; `oracle` gets a second opinion on the decision/task at hand. Both spawn ephemeral children, collect their reports, synthesize, and tear the children down — you stay in the current session. For each named agent:

```bash
orca terminal create --worktree active --title <verb>-<agent> --command "<agent>" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration task-create --spec "<review or oracle instruction for the current task>" --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
```

Collect each child's report, best-effort, with a bounded wait (one wait per dispatched child):

```bash
orca orchestration check --wait --types worker_done,escalation --timeout-ms 900000 --json
```

Consolidate every report into a single de-duped digest written back into this session — do not make the user open the child tabs. Then tear each child down (`orca terminal close` lives in `orca-cli`):

```bash
orca terminal close --terminal <handle> --json
```

- `review` instruction: review the current changes/diff and report findings only. Children are advisory and read-only — they must not edit the working tree, since all children share this worktree and edits would collide.
- `oracle` instruction: give a second opinion on the current decision/task; consolidate the opinions and factor them into your next response.
- Children appear under the current worktree (the existing child-spawn path); no new worktree handling is involved. Completion is best-effort: a child that does not report `worker_done` within the wait is noted as incomplete in the digest rather than waited on indefinitely. `--inject` reports `worker_done` only for recognized agent CLIs, so a named agent that is not injection-recognized may come back incomplete.

### `handoff <agent>` — new persistent tab

`handoff` moves the work to another agent in the same worktree. Open a new persistent tab running the named agent and seed it with a context brief. This is a full ownership transfer, so do NOT use `--inject` and do not create lifecycle obligations:

```bash
orca terminal create --worktree active --title handoff-<agent> --command "<agent>" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal <handle> --text "<context brief>" --enter --json
```

The brief summarizes the current conversation so a fresh agent can continue the work. Do not duplicate content already captured in other artifacts (PRDs, plans, issues, commits) — reference them by path or URL instead. Unlike a worktree handoff (see Full Handoffs), this stays in the current worktree as a new tab; the user moves to that tab to continue.

## Ownership

Orchestration messages and tasks are runtime-global. Completion authority comes from the active dispatch context: `taskId` + `dispatchId` + assignee handle.

Classify inherited context before sending lifecycle messages:

- Coordinated subtask: a live coordinator owns the DAG and waits on this dispatch. Follow the preamble exactly, including `worker_done`, heartbeat/status, `ask`, and `escalation`.
- Full handoff means ownership transfer, not supervised dispatch. The original actor is not monitoring a DAG, so do not create lifecycle obligations unless the user explicitly asks you to supervise.
- Do not use `orca orchestration dispatch --inject` for full handoffs. It injects a coordinator preamble that tells the worker to send `worker_done`, heartbeat, `ask`, and post-completion polling messages back to the original terminal.

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
orca orchestration check [--terminal <handle>] [--unread] [--types <type,...>] [--inject] [--wait] [--timeout-ms <n>] [--json]
orca orchestration reply --id <msg_id> --body <text> [--from <handle>] [--json]
orca orchestration ask --to <handle> --question <text> [--options <csv>] [--timeout-ms <n>] [--from <handle>] [--json]
orca orchestration inbox [--limit <n>] [--json]
```

Rules:

- Omit `--from` unless impersonating another terminal; Orca auto-resolves it from the current terminal.
- While supervising workers manually, use `check --wait --types worker_done,escalation,decision_gate --timeout-ms <n>` instead of sleep/poll loops. Reply to `decision_gate` messages with `orca orchestration reply --id <msg_id> --body <answer> --json`, then keep waiting.
- Treat a `check --wait` timeout or `{count:0}` as a checkpoint, not a worker failure. Long coding tasks routinely run 15-60 minutes; keep using rolling waits unless you receive `worker_done`/`escalation`, the terminal exits or disappears, or the user explicitly asks you to stop.
- Heartbeats and visible terminal activity mean the worker is alive, not done. Do not stop, close, kill, or restart a worker just because it has not produced a completion message yet.
- Use `ask` when a worker needs a blocking answer from the coordinator; it waits for the reply and returns the answer directly.
- `check --wait` returns one message at a time. If N workers may finish together, loop N times and dispatch newly ready tasks after each completion.
- Group addresses include `@all`, `@idle`, `@claude`, `@codex`, `@opencode`, `@gemini`, `@droid`, and `@worktree:<id>`.
- Message types include `status`, `dispatch`, `worker_done`, `merge_ready`, `escalation`, `handoff`, `decision_gate`, and `heartbeat`.
- Use group addresses only for messages that are genuinely useful to many terminals, such as `status` broadcasts or intentional fan-out questions. Do not send dispatch lifecycle messages to groups.
- `worker_done` must target the concrete coordinator handle from the live preamble. It is completion authority for one dispatch; group fanout would create false lifecycle mail in unrelated terminals.
- `heartbeat` is also dispatch-scoped. Send it only to the concrete coordinator handle with both `taskId` and `dispatchId`; use `status` for broad progress updates.

## Tasks And Dispatch

A task is the work item, a dispatch assigns it to a terminal, and a gate blocks progress until a coordinator or user decision is recorded.

```bash
orca orchestration task-create --spec <text> [--deps <json_array>] [--parent <task_id>] [--json]
orca orchestration task-list [--status <status>] [--ready] [--json]
orca orchestration task-update --id <task_id> --status <status> [--result <json>] [--json]
orca orchestration dispatch --task <task_id> --to <handle> [--from <handle>] [--inject] [--json]
orca orchestration dispatch-show --task <task_id> [--json]
```

Task statuses: `pending`, `ready`, `dispatched`, `completed`, `failed`, `blocked`.

Dispatch rules:

- `--inject` sends the task spec plus preamble into a recognized agent CLI so it can report `worker_done`.
- If the target is a bare shell, omit `--inject`, dispatch for tracking if needed, then send the prompt manually with `orca terminal send --terminal <handle> --text <prompt> --enter --json`.
- After 3 consecutive failures on one task, the dispatch context circuit-breaks and the task is marked failed.

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

New top-level worktree handoff:

```bash
orca worktree create --name <task-name> --no-parent --agent codex --prompt "<task brief>" --json
```

Existing terminal handoff:

```bash
orca terminal send --terminal <handle> --text "<task brief>" --enter --json
```

`--no-parent` only controls Orca lineage; it does not choose the Git base. For an independent top-level worktree, omit `--base-branch` so Orca uses the repo default base, or explicitly pass the repo default base (`origin/main`, `origin/master`, or the `orca repo show --repo <selector> --json` value); never base it on the current feature branch unless the user explicitly asks for stacked work or "branch from current". Put current-branch context in the prompt instead.

## Worker Terminals

Choose the worker location before creating a terminal. `Fresh worker` means a fresh agent session, not a new git worktree. If the task says current worktree only, depends on uncommitted files/artifacts, or must validate/PR the current branch, create the worker in the active worktree:

```bash
orca terminal create --worktree active --title <task-name> --command "codex" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
```

Reuse an idle agent in the required worktree only if the prompt allows reuse; otherwise create a fresh terminal there. Use a new worktree only when explicitly requested or when independent isolated checkout state is intended. For supervised new-worktree workers, decide the Git base separately from lineage: `--no-parent` makes the worktree top-level in Orca, while omitted `--base-branch` uses the repo default base.

```bash
orca worktree create --name <task-name> --agent codex --json
orca terminal list --worktree id:<newWorktreeId> --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
```

For new-worktree workers, read the id from `worktree create`, then use `terminal list` to get the agent handle. Omit `--repo` only inside an Orca-managed worktree; otherwise pass `--repo <selector>`. `--agent` reveals the new worktree and launches the selected agent in its first terminal, so do not create a separate startup terminal. Do not run `worktree create` when the task must stay in the current worktree.

Use `orca worktree create --prompt ...` or `orca terminal send ...` for full handoffs or untracked/lightweight prompts. Those paths do not attach `taskId`/`dispatchId`; the worker should not send lifecycle messages unless the prompt supplies a live orchestration preamble.

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

- Workers with a valid live preamble must send `worker_done` exactly once, even on failure:
  `orca orchestration send --to <coordinator_handle> --type worker_done --subject "<short status>" --body "<3-sentence summary: what you did, what you found, what's left>" --payload '{"taskId":"<task_id>","dispatchId":"<dispatch_id>","filesModified":["path/a"],"reportPath":"<optional>"}' --json`
- For long tasks, send heartbeat/status only when the preamble asks for it, including both IDs:
  `orca orchestration send --to <coordinator_handle> --type heartbeat --subject "alive" --payload '{"taskId":"<task_id>","dispatchId":"<dispatch_id>","phase":"implementing"}' --json`
- If blocked before completion, use `ask`; use `escalation` only when ownership is valid and the coordinator must intervene.
- Treat preambles inherited through terminal history or full handoffs as stale unless the current prompt explicitly keeps that coordinator in the loop.
- Coordinators should use `task-list --ready` as external memory, dispatch parallel waves, and avoid dependency chains deeper than 3-4 steps.
- Prefer inter-worktree workers only for independent work that does not need current uncommitted state. When same-worktree work is required, create fresh terminals in that worktree and keep edit ownership clear.

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
