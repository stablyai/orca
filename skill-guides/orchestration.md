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

If a task says to use Orca orchestration, the coordinator must create or bind a Run, create the Task with `orca orchestration task-create`, then attach the worker with either the preferred `orca orchestration worker-start` composition or the low-level `orca orchestration dispatch --inject` path.

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

## Contract Migration

Orca adopts a live pre-update orchestration assignment into an ordinary Run. Adoption preserves the existing agent process, PTY/session, terminal handle, tab/leaf/pane, worktree or folder workspace, Task, and Dispatch; it never restarts or replaces the worker. The retired scheduler is not revived, and a newly created attempt uses the current grammar.

Treat the authority label on injected or formatted messages as definitive:

- `[LEGACY COMPATIBILITY]` is live and attested. Run only the exact supported command printed with the message, using the same CLI executable and arguments that the original prompt supplied.
- `[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]` is one bounded, at-least-once cutover replay. Process it idempotently and acknowledge it only through the exact displayed guidance.
- `[LEGACY READ-ONLY]` is inspection-only. It has no reply, acknowledgment, or lifecycle action.
- An unlabeled current message uses the current guide and current grammar.

An explicitly selected current Run, attested current Run binding, current Dispatch, or federated attachment takes precedence over legacy fallback. A retained adoption record alone never turns a current command into a legacy call.

Database provenance, an old-looking terminal, or a legacy Run ID does not prove mutation authority. If the runtime cannot prove liveness, principal ownership, capability, or the exact legacy contract, it degrades to read-only inspection and must not fall back to local execution. Exact recovery may restore the already-live PTY once in its original inactive background tab. It must not spawn, write, signal, stop, switch, focus, split, or inject a terminal. Loss of lifecycle authority does not invalidate the existing assignment, process, or filesystem work.

Compatibility retries have narrow guarantees. A pending ask, a reply, a final Dispatch settlement, and a consuming check have durable recovery identities. A-era heartbeat and escalation calls remain at-least-once across a manual A-to-B retry because identical later signals may be intentional. If an A-era ask may already have been answered, run the exact non-consuming recovery check printed by the runtime first; after its answer is printed and acknowledged, a new invocation with the same question creates a new question. Never guess among multiple identical question threads.

When a compatibility or recovery command returns structured next-step arguments, run those exact arguments with the same CLI executable. The arguments intentionally omit the executable name so the guidance works with `orca`, `orca-ide`, `orca-dev`, or another configured Orca CLI command. Do not translate the command from memory, broaden its recipient, or retry it as a current mutation unless the returned guidance explicitly says to.

On packaged Windows, a legacy ask uses a two-step commit/resume protocol. The initial command durably commits the question, prints its exact `ask --resume <message_id>` command, and exits with launcher status `75`; it does not wait for the answer. Run that exact resume command after the launcher or update boundary. Resume is idempotent and read-oriented: it waits for the already-committed question and does not create another one. For a WSL process that received compatibility proof at launch, use the printed executable `orca-ide` WSL resume command so the same distro and packaged launcher authority are preserved; do not substitute a PATH-resolved local CLI. Older WSL processes that never received the hidden launch token remain lifecycle read-only after the update, even while their terminal and filesystem work continue.

Legacy inspection remains available without consuming mail:

```bash
orca orchestration run-list --json
# run_legacy_local is an empty audit tombstone after adoption.
orca orchestration run-show --id run_legacy_local --json
# In run-list, find the ordinary Run whose objective is:
# "Recovered orchestration work from a contract update"
orca orchestration run-show --id <adopted_run_id> --json
orca orchestration task-list --run <adopted_run_id> --json
orca orchestration inbox --full --json
orca orchestration check --terminal <legacy_handle> --peek --format --json
orca terminal read --terminal <legacy_handle> --json
orca terminal wait --terminal <legacy_handle> --for tui-idle --timeout-ms 60000 --json
```

If the original coordinator is unavailable or cannot prove its retained authority, a current coordinator may explicitly take over the adopted Run from its own live agent terminal:

```bash
orca orchestration run-use --id <adopted_run_id> --takeover-legacy --json
orca orchestration check --run <adopted_run_id> --json
```

Takeover fences only the old coordinator, binds the current one, and moves pending worker mail into current Run Delivery. It is bound to the authenticated invoking terminal; `--from` cannot name another coordinator. Live legacy workers keep their original Tasks, Dispatches, processes, filesystems, and old prompt commands; their later questions, escalations, and completion reports route to the current coordinator. Do not use takeover while the original coordinator is still actively coordinating, because its later lifecycle mutations are rejected.

Do not launch a replacement editor merely because the desktop app or runtime was updated. If adoption cannot prove continuing authority, keep the original worker as the only editor until it reaches a stable handoff point, then use a new current Dispatch in a conflict-free placement for any remaining work.

## Ownership

New orchestration messages and tasks belong to one explicitly bound Run. A Run is only a durable namespace and coordinator inbox; it never schedules or places workers. Lifecycle authority comes from the active Dispatch, and terminal handles remain routing metadata rather than durable identity. Send `worker_done` and `heartbeat` from the worker's own terminal; Orca routes them to that Dispatch's Run.

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
orca orchestration send --subject <text> [--to <run:id|dispatch:id|legacy_handle>] [--from <handle>] [--body <text>] [--type <type>] [--priority <level>] [--thread-id <id>] [--payload <json>] [--json]
orca orchestration check [--terminal <handle>] [--ack <delivery_id>] [--peek|--all] [--types <type,...>] [--format] [--wait] [--timeout-ms <n>] [--json]
orca orchestration reply --id <msg_id> --body <text> [--from <handle>] [--json]
orca orchestration ask (--question <text>|--resume <msg_id>) [--options <csv>] [--timeout-ms <n>] [--from <handle>] [--json]
orca orchestration inbox [--limit <n>] [--json]
```

Rules:

- Omit `--from` unless impersonating another terminal; Orca auto-resolves it from the current terminal.
- A coordinator `check` returns the bound Run's oldest FIFO Delivery (up to 50 messages) and replays that exact batch until `--ack <delivery_id>`. Process every message before acknowledging; `check --ack <id> --wait` acknowledges, checks, and waits in one operation.
- Use `--peek` and `--all` only for read-only history/debugging. Type filters decide when a waiter wakes; the returned actionable Delivery is still the oldest full batch.
- Use `dispatch:<id>` for coordinator guidance to one supervised worker. Orca routes that stable address locally or through the connected-server relay; do not substitute a remote terminal handle.
- Terminal handles remain appropriate for low-level pre-Dispatch messaging. Prefer `agentTerminalHandle` from the create response, fall back to `startupTerminal.handle` for older runtimes, then re-resolve with `orca terminal list --worktree ... --json` if missing or stale. Continue with the replacement handle only; never dual-send to old and new handles.
- `terminal list --json` omits `visualLayouts` because handle recovery does not need topology. Add `--include-visual-layouts` only for explicit tab and pane inspection.
- `orca orchestration check --peek --format --json` returns locally formatted unread mail without consuming it; it never writes to terminal input or remotely wakes another terminal. Use `orchestration dispatch --inject` to deliver a tracked task, or `terminal send` when an existing agent needs a free-form prompt.
- While supervising workers manually, use `check --wait --types worker_done,escalation,question --timeout-ms <n>` instead of sleep/poll loops. Process the whole Delivery, reply to `question` messages with `orca orchestration reply --id <msg_id> --body <answer> --json`, then acknowledge and keep waiting.
- Treat a `check --wait` timeout or `{count:0}` as a checkpoint, not a worker failure. Long coding tasks routinely run 15-60 minutes; keep using rolling waits unless you receive `worker_done`/`escalation`, the terminal exits or disappears, or the user explicitly asks you to stop.
- Heartbeats and visible terminal activity mean the worker is alive, not done. Do not stop, close, kill, or restart a worker just because it has not produced a completion message yet.
- Use `ask` when a worker needs a blocking answer from the coordinator; it defaults to the active Dispatch's Run. Timeout or disconnect leaves the question pending, so resume by its original message ID instead of asking again.
- `check --wait` returns one bounded Delivery, not every future completion. Process every message, acknowledge it, then keep waiting until every expected Dispatch settles.
- Group addresses include `@all`, `@idle`, `@claude`, `@codex`, `@opencode`, `@gemini`, `@droid`, `@grok`, `@cursor`, and `@worktree:<id>`.
- Message types include `status`, `dispatch`, `worker_done`, `merge_ready`, `escalation`, `handoff`, `question`, `decision_gate` (legacy/gates), and `heartbeat`.
- Use group addresses only for messages that are genuinely useful to many terminals, such as `status` broadcasts or intentional fan-out questions. Do not send dispatch lifecycle messages to groups.
- `worker_done` belongs to the active Dispatch and defaults to its Run mailbox; never target a group.
- A valid `worker_done` for the active `taskId` + `dispatchId` marks the task and dispatch completed automatically. Do not follow it with `task-update --status completed`; reserve manual updates for explicit recovery or overrides.
- `heartbeat` is also Dispatch-scoped. Include both IDs and omit `--to` so Orca uses the owning Run; use `status` for broad progress updates.

## Tasks And Dispatch

A Run is the namespace/inbox, a Task is the work item, and a Dispatch assigns one Task attempt to a terminal. Create or bind a Run once before the common loop.

```bash
orca orchestration run-create --objective <text> --json
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

## Preferred Supervised Worker Loop

Use `worker-start` for the normal supervised path. It composes the existing worktree, terminal, readiness, and dispatch primitives while returning exact created/reused effects. Agents still choose placement and concurrency; Orca does not schedule workers or infer conflicts.

Create the Run and every independent Task first, then start all independent workers before waiting:

```bash
orca orchestration run-create --objective "<objective>" --json
orca orchestration task-create --spec "<worker A task>" --json
orca orchestration task-create --spec "<worker B task>" --json
orca orchestration worker-start --task <task_a> --worktree current --agent codex --json
orca orchestration worker-start --task <task_b> --worktree current --agent claude --json
```

`current` and exact existing worktrees create a fresh agent terminal and do not rerun setup. Reuse an existing agent only with `--terminal <handle>`.

For a per-invocation Claude, Codex, or Cursor launch, pass an opaque provider model id with `--model`; add `--effort` only when that agent/model supports the level. These options apply only to fresh agent terminals, override general agent default arguments, and are reported under `launch.requested` and `launch.effective` in the receipt:

```bash
orca orchestration worker-start --task <task_id> --worktree current --agent claude --model aws-bedrock-opus-5 --effort high --json
```

`--effort` requires `--model`, and neither option can combine with `--terminal`. A connected worker server must advertise launch-preference support before Orca forwards either option.

For a new worktree, setup runs by default and agent-first creation reuses the returned startup agent terminal:

```bash
orca orchestration worker-start --task <task_id> --worktree new-child --name <name> --agent codex --setup run --json
# Independent/top-level:
orca orchestration worker-start --task <task_id> --worktree new-top-level --name <name> --agent codex --setup run --json
```

Setup normally starts alongside the agent. Only a repository explicitly configured with `wait-for-setup` delays agent launch until setup succeeds. Use `--setup skip` or `--setup inherit` only for a concrete reason.

Read the returned receipt before continuing: `ready` plus setup `running` is normal for start-immediately, while wait-for-setup returns setup `succeeded` before accepting task input. A failed or unknown start exits nonzero; inspect its `stage`, `effects`, and `residualResources` instead of guessing or automatically retrying. A wait-for-setup timeout can honestly leave setup `running`, which is not proof of failure.

To run the worker on another connected Orca server, add `--on <saved-environment>`. The Run and Tasks remain authoritative on the current server; later commands route by Dispatch ID, so never repeat `--on`:

```bash
# Mac Run home -> Windows worker (the reverse is identical from a Windows Run home)
orca orchestration worker-start --task <task_id> --on windows --worktree new-top-level --repo <exact_remote_repo_selector> --name <name> --agent codex --setup run --json
orca orchestration worker-show --dispatch <dispatch_id> --json
orca orchestration worker-read --dispatch <dispatch_id> --limit 50 --json
orca orchestration send --to dispatch:<dispatch_id> --subject "Follow-up" --body "<attempt-specific guidance>" --json
```

Remote `current` and `new-child` are intentionally invalid because those words are ambiguous across servers. Use an exact discovered remote worktree selector or `new-top-level` with an explicit remote repo selector.

The follow-up is structured inbox mail, not prompt injection. The worker's next
`orchestration check` receives it even when the Dispatch is on another connected Orca server.

`worker-read` defaults to `--source auto`: Orca returns the exact hook-reported Codex, Claude, OpenClaude, or Grok transcript when it can prove the worker session, otherwise it returns bounded terminal output with `source: "terminal"` and a typed `fallbackReason`. Continue with the returned top-level `cursor`; it stays pinned to that exact source. If Orca reports `source_changed`, start a fresh read without the old cursor. Never supply or guess a provider session ID or transcript path.

Wait until every expected Dispatch settles, not for a fixed number of batches:

```bash
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
# Process every message. For each accepted worker_done that is not immediately reused:
orca orchestration worker-release --dispatch <dispatch_id> --json
# Acknowledge only after every message and required release decision is handled:
orca orchestration check --ack <delivery_id> --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

After processing each accepted `worker_done`, choose the terminal's next owner before you acknowledge the Delivery or wait again. If the same exact agent has an immediate follow-up Task, read the `worker.agent_terminal_handle` field of `worker-show --dispatch <dispatch_id> --json`, then run `orca orchestration worker-start --task <next_task_id> --terminal <handle> --json` so Orca transfers cleanup ownership to the new Dispatch. Otherwise run `orca orchestration worker-release --dispatch <dispatch_id> --json`.

Run `worker-release` after both succeeded and failed `worker_done` reports unless the user explicitly asked to keep that worker live. Release is post-completion cleanup, not cancellation: Orca first preserves inspectable output, then closes only the exact agent terminal owned by that settled Dispatch. Reused or pre-existing terminals, setup terminals, coordinators, active workers, user-taken-over terminals, and identities Orca cannot prove are retained. If the user explicitly asks to keep the live terminal for debugging, record that exception with `orca orchestration worker-retain --dispatch <dispatch_id> --json` instead of silently skipping cleanup. When the user is finished, the same Dispatch can be passed to `worker-release`, which clears the requested retention and releases the terminal.

Do not release a worker because of a timeout, TUI idle state, heartbeat, status, question, escalation, or rejected/stale `worker_done`. If release returns `release_pending` or `release_unknown`, do not substitute `terminal close`; follow the exact recovery action in the receipt. A replayed Delivery may repeat `worker-release` safely.

Workers report exactly once using the IDs and capability injected by Orca; they do not supply Run/server/terminal identity:

```bash
orca orchestration send --type worker_done --subject "<status>" --body "<what changed, findings, and what remains>" --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded --files-modified "path/a,path/b" --json
# On failure, use --outcome failed; never encode failure only in prose.
```

A worker question defaults to its owning Run. Timeout leaves it pending:

```bash
orca orchestration ask --question "<question>" --options "yes,no" --timeout-ms 600000 --json
orca orchestration ask --resume <message_id> --timeout-ms 600000 --json
# Coordinator:
orca orchestration reply --id <message_id> --body "<answer>" --json
```

Recovery is conditional, never a fixed destructive sequence:

- `worker-show --dispatch <id>` says `ready`: keep waiting or read bounded output.
- It proves `failed` or `stopped`: start a replacement with `worker-start --task <task> --retry-of <id>` plus an explicit `--on`/`--worktree` and `--agent`/`--terminal` choice. Retry does not silently inherit placement.
- It remains `outcome_unknown`: either `worker-stop --dispatch <id>` and inspect again, or explicitly `worker-abandon --dispatch <id>` while accepting that resources may still be live. Abandon performs no remote, process, or filesystem action.
- `worker-stop` closes only the exact supervised agent terminal. It never deletes the worktree, setup terminal, configured tabs, or unrelated processes.

Low-level `worktree create`, `terminal create`, and `dispatch --inject` remain valid recipes for custom argv or topology that `worker-start` does not express.

## Gates And Legacy Inspection

```bash
orca orchestration gate-create --task <task_id> --question <text> [--options <json_array>] [--json]
orca orchestration gate-resolve --id <gate_id> --resolution <text> [--json]
orca orchestration gate-list [--task <task_id>] [--status <status>] [--json]
```

Use `ask` for worker-to-coordinator questions; it creates a `question` message that the coordinator answers with `reply`. Use `gate-create` only for coordinator-managed task DAG decisions, not for answering a worker's `ask`.

`coordinator-start`, `coordinator-stop`, `run`, and `run-stop` are retired scheduler commands. They perform no effects and return the current-skill recovery action. They are not aliases for lightweight Run creation or binding.

Recovery only: `orca orchestration reset --tasks|--messages|--all --json` clears the selected local orchestration database state. Do not run it during active coordination unless explicitly abandoning that state.

## Full Handoffs

For full ownership transfer, use non-lifecycle terminal/worktree commands and then stop monitoring unless the user asks for supervision.

Treat these as full handoff requests by default: "hand off", "handoff", "handover", "give this to another agent", "give this to another worktree", "send this to another agent", "another agent", "another worktree", or "launch another agent to own this." Custom model or reasoning effort words such as `gpt-5.5`, `high`, or `xhigh` do not make the handoff supervised.

Supervised orchestration remains available only when the user explicitly asks for supervision or coordination: "supervise", "monitor", "wait for worker_done", "wait for results", "track completion", "DAG", "decision gate", "ask/reply", or "coordinate workers."

Do not run `orca orchestration task-create`, `orca orchestration dispatch --inject`, or `orca orchestration check --wait` for full handoffs. `task-create` is also forbidden because it records coordinator-owned tracking state; if a task row is needed, the user asked for supervised orchestration. Do not create a `taskId`/`dispatchId`, inject a lifecycle preamble, wait for completion, or read the worker terminal after prompt delivery except to avoid losing the initial prompt.

New top-level worktree handoff:

```bash
orca worktree create --name <task-name> --no-parent --agent codex --prompt "<task brief>" --setup run --json
```

Before creating a new worktree from an active feature branch, decide and state whether the desired Orca lineage is child or top-level. Use child worktree lineage only when the new work is conceptually stacked under or dependent on the active worktree. For independent repo-wide fixes, standalone feature work, or unrelated follow-up tasks, create a top-level worktree with `--no-parent`.

Existing terminal handoff:

```bash
orca terminal send --terminal <handle> --text "<task brief>" --enter --json
```

Custom Codex model/effort handoff:

`orca worktree create --agent codex --prompt ...` launches the known Codex agent but does not accept Codex-specific `--model` or `-c model_reasoning_effort=...` arguments. When the user asks for a specific Codex model or effort, create the independent worktree first, launch Codex with the requested command in that worktree, wait only for TUI readiness if prompt delivery would otherwise race startup, send the prompt, and stop.

The two-step custom-argv path cannot enforce a repository's explicit `wait-for-setup` startup policy because the later `terminal create` is not the startup owned by `worktree create`. Use it only when the repository starts agents immediately. If the repository requires `wait-for-setup`, use an agent-first configured launcher that can preserve sequencing, or stop and ask rather than silently bypassing the policy.

Note: when no repo default-terminal configuration supplies a primary terminal, bare create opens a fallback shell before `terminal create` adds the agent. Configured default tabs are materialized instead and may run real commands. Prefer `--agent` whenever custom argv is not required. With the two-step path, target only the agent handle; close a prior terminal only after `terminal list` or `terminal show` confirms it is an unused shell.

Use the exact full `<repo-id>::<path>` worktree id returned by `orca worktree create --json`; a bare repo id cannot target the new worktree.

```bash
orca worktree create --name <task-name> --no-parent --setup run --json
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

For every new worktree, pass `--setup run` so any configured repository setup hook runs. This does not mean waiting for setup before agent launch: preserve the repository's startup policy, whose default starts setup and the agent side by side. Use `--setup skip` or `--setup inherit` only when there is a concrete task-specific reason, and state that reason before creating the worktree. This rule does not rerun setup for current or existing worktrees.

```bash
orca worktree create --name <task-name> --agent codex --setup run --json
# or: --agent claude | omp | pi | grok | ...
# Read <handle> from agentTerminalHandle, falling back to startupTerminal.handle.
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
```

For new-worktree workers, read the id and `agentTerminalHandle` from `worktree create`, falling back to `startupTerminal.handle` for older runtimes. Use that as the sole worker handle when present; otherwise use `terminal list` to resolve the agent handle. Omit `--repo` only inside an Orca-managed worktree; otherwise pass `--repo <selector>`.

**For an allowed new worktree, use agent-first:** `--agent` reveals the new worktree and launches the selected agent **in its first terminal**, without adding a separate fallback shell for that worker. Pass `--setup run`; repo setup and default-terminal settings may add intentional tabs or splits. Do **not** run bare `worktree create` and then `terminal create --command <agent>` for the same worker when agent-first create is available: without configured default tabs, that two-step path leaves a fallback shell + agent pair. Only use it when custom agent argv is required (for example Codex model/effort flags) or when an older CLI rejects `--agent`; if you must, message only the agent handle. Configured default tabs are intentional surfaces, so close a prior terminal only after `terminal list` or `terminal show` confirms it is an unused shell. Do not run `worktree create` when the task must stay in the current worktree.

Use `orca worktree create --prompt ...` or `orca terminal send ...` for full handoffs or untracked/lightweight prompts. Those paths do not attach `taskId`/`dispatchId`; the worker should not send lifecycle messages unless the prompt supplies a live orchestration preamble.

Sidebar lineage and orchestration lifecycle are related but not identical. A same-worktree worker may appear as a peer under that worktree in the sidebar while remaining a child dispatch in orchestration state; only an actual child worktree creates visible parent/child worktree lineage.

Other terminal commands coordinators often need:

```bash
orca terminal list [--worktree <selector>] [--include-visual-layouts] [--json]
orca terminal create [--worktree <selector>] [--title <text>] [--command <cmd>] [--json]
orca terminal split --terminal <handle> [--direction horizontal|vertical] [--command <cmd>] [--json]
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms <n> --json
orca terminal read --terminal <handle> --json
orca terminal send --terminal <handle> --text <text> --enter --json
```

If an older CLI rejects `worktree create --agent`, create the worktree normally, then run `orca terminal create --worktree <selector> --command "codex" --json` or `--command "claude"`.

Wait for `tui-idle` before dispatching. Always pass `--timeout-ms`; real coding tasks can take 15-60 minutes. During supervision, use rolling `check --wait` windows. If a window returns no matching message, inspect `task-list`, `terminal read`, or `terminal wait --for tui-idle` as a liveness checkpoint; if the terminal is still working or producing activity, keep waiting instead of retrying the task.

## Agent Guidance

- Workers with a valid live preamble must send `worker_done` exactly once from their own terminal with an explicit `--outcome succeeded` or `--outcome failed`:
  `orca orchestration send --type worker_done --subject "<short status>" --body "<3-sentence summary: what you did, what you found, what's left>" --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded --files-modified "path/a" --report-path "<optional>" --json`
- A failed outcome is still a terminal report, but Orca records both the Dispatch and Task as failed. Never encode failure only in the subject/body.
- After sending `worker_done`, end your turn and idle at the agent prompt. The coordinator may reuse or release this terminal after it processes your report; do not start more work, poll, or attempt to close the terminal yourself. If it reuses you, it re-engages you with a fresh preamble + TASK block delivered as new terminal input.
- For long tasks, send heartbeat/status only when the preamble asks for it, including both IDs:
  `orca orchestration send --type heartbeat --subject "alive" --payload '{"taskId":"<task_id>","dispatchId":"<dispatch_id>","phase":"implementing"}' --json`
- If blocked before completion, use `ask`; use `escalation` only when ownership is valid and the coordinator must intervene.
- Treat preambles inherited through terminal history or full handoffs as stale unless the current prompt explicitly keeps that coordinator in the loop.
- Coordinators must account for every settled worker terminal before waiting again or ending the turn: immediately reuse the exact worker for a new Dispatch, explicitly retain it at the user's request with `worker-retain`, or run `worker-release`. Do not leave a completed worker live merely to inspect output; released workers remain readable through `worker-read`.
- Coordinators should use `task-list --ready` as external memory, dispatch parallel waves, and avoid dependency chains deeper than 3-4 steps.

## Example

```bash
orca terminal create --worktree active --title login-css-worker --command "claude" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration task-create --spec "Fix the login button CSS" --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

## Next Action

Coordinator: confirm `orca status --json`, create or bind a Run, inspect `task-list`/`dispatch-show` if inheriting state, then use the explicit supervised loop (`task-create` -> `worker-start` -> `check --wait`). Use low-level terminal creation plus `dispatch --inject` only when the composed start does not express the needed topology. After every accepted `worker_done`, either transfer the exact terminal to an immediate follow-up Dispatch or run `worker-release` before the next wait.

Worker: if the current prompt contains a live dispatch preamble, do the task, use `ask` for blocking questions, and send `worker_done` once with the required payload. If the preamble is stale or absent, do not send lifecycle messages; inspect state or treat the prompt as an ordinary handoff.
