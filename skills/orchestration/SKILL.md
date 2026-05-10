---
name: orchestration
description: >-
  Use `orca orchestration` when coordinating multiple AI agents through Orca:
  pass context, instructions, questions, findings, reviews, handoffs, or
  structured results between agents; delegate subtasks; dispatch work; track task
  DAGs; wait for worker_done/escalation; or run coordinator loops and decision
  gates. This is the right skill for semantic agent-to-agent communication.
  Boundary with `orca-cli`: do not use orchestration for ordinary terminal
  control, shell commands, browser automation, worktree management, or
  reading/waiting on terminals; use `orca-cli` for those. Triggers include "tell
  the other agent", "ask <agent>", "hand off to", "pass this to <agent>",
  "delegate to <agent>", "have <agent> do X", "let <agent> know", "share with the
  other AI", "coordinate agents", "what did <agent> find", "check orchestration
  inbox", "reply to <agent>", "dispatch task", "orchestrate agents",
  "multi-agent", "task DAG", "worker_done", "escalation", "decision gate", and
  "coordinator loop".
---

# Orca Inter-Agent Orchestration

Use this skill when the task involves coordinating multiple coding agents through Orca's orchestration system. For basic terminal and worktree management, use the `orca-cli` skill instead.

## When To Use

- You need to send messages between agent terminals
- You need to decompose a spec into parallel subtasks with dependencies
- You need to dispatch tasks to worker agents with structured feedback
- You need to act as a coordinator managing a multi-agent workflow
- You need to create decision gates for human-in-the-loop checkpoints

## Preconditions

- Orca must be running (`orca status --json` should return `runtime: true`).
- The `orca` CLI must be on PATH (installed via Settings > Browser > Enable Orca CLI).
- The orchestration experimental feature must be enabled in Settings > Experimental.
- All `orca orchestration` commands are RPC calls to the running Orca runtime — they require an active Orca session.

## Command Surface

### Messaging

Inter-agent messaging via persistent SQLite-backed mail store. Messages are delivered automatically when the recipient agent goes idle (push-on-idle).

```bash
orca orchestration send --to <handle|@group> --subject <text> [--from <handle>] [--body <text>] [--type <type>] [--priority <level>] [--thread-id <id>] [--payload <json>] [--json]
orca orchestration check [--terminal <handle>] [--unread] [--types <type,...>] [--inject] [--wait] [--timeout-ms <n>] [--json]
orca orchestration reply --id <msg_id> --body <text> [--from <handle>] [--json]
orca orchestration inbox [--limit <n>] [--json]
```

Why: `--from` auto-resolves via the `ORCA_TERMINAL_HANDLE` environment variable injected into every Orca-managed terminal. Omit it unless impersonating another terminal.

Why: `--inject` formats messages as readable banners with priority indicators (`[HIGH]`, `[URGENT]`) for agent prompt injection. Use `--json` for machine-readable output.

Why: `--wait` blocks until a matching message arrives or the timeout expires (default 2 minutes). This replaces sleep+poll loops. If unread messages already exist, returns immediately. Combine with `--types` to wait for specific message types (e.g. `--wait --types worker_done --timeout-ms 120000`).

**Message types**: `status` (general), `dispatch` (assign work), `worker_done` (signal completion), `merge_ready` (branch ready for merge), `escalation` (issue requiring attention), `handoff` (pass work to another agent), `decision_gate` (human-in-the-loop).

**Priority levels**: `normal`, `high`, `urgent`.

**Group addresses** resolve to terminal handles:

| Group | Resolves To |
|-------|------------|
| `@all` | All terminal handles except sender |
| `@idle` | Handles where the agent is currently idle |
| `@claude` | Handles running Claude Code |
| `@codex` | Handles running Codex |
| `@opencode` | Handles running OpenCode |
| `@gemini` | Handles running Gemini |
| `@worktree:<id>` | All handles in a specific worktree |

Group messages fan out: one message per recipient, shared `thread_id`, independent read tracking.

### Tasks

Task tracking with DAG dependencies. A task becomes `ready` when all tasks in its `deps` array are `completed`.

```bash
orca orchestration task-create --spec <text> [--deps <json_array>] [--parent <task_id>] [--json]
orca orchestration task-list [--status <status>] [--ready] [--json]
orca orchestration task-update --id <task_id> --status <status> [--result <json>] [--json]
```

**Task statuses**: `pending` (waiting on deps), `ready` (deps met, dispatchable), `dispatched` (assigned to a terminal), `completed`, `failed`, `blocked` (waiting on a decision gate).

Why: when a task is marked `completed`, the runtime automatically promotes any pending tasks whose deps are now all satisfied to `ready`. This is the DAG resolution step.

### Dispatch

Dispatch assigns a ready task to a terminal. Optionally injects the task spec + preamble into the terminal so the agent knows how to communicate back.

```bash
orca orchestration dispatch --task <task_id> --to <handle> [--from <handle>] [--inject] [--json]
orca orchestration dispatch-show --task <task_id> [--json]
```

Why: `--inject` sends a preamble that teaches the agent how to use `orca orchestration send --type worker_done` to report completion. All agents have `orca` on PATH and can execute shell commands. The preamble maximizes structured feedback but the system works without it (coordinator falls back to idle detection + output reading).

Why: `--inject` requires a recognized agent CLI (e.g. Claude Code) running in the target terminal. If the terminal is a bare shell, omit `--inject` and send the prompt manually with `terminal send`.

Why: dispatch contexts are separate from tasks (sling pattern). A task can be dispatched, fail, and be re-dispatched to a different terminal — the task stays clean while dispatch contexts track retry state.

**Circuit breaker**: After 3 consecutive failures on a task, the dispatch context is marked `circuit_broken`. The task is marked `failed` to prevent infinite retry loops.

### Decision Gates

Human-in-the-loop decision points that block a task until resolved.

```bash
orca orchestration gate-create --task <task_id> --question <text> [--options <json_array>] [--json]
orca orchestration gate-resolve --id <gate_id> --resolution <text> [--json]
orca orchestration gate-list [--task <task_id>] [--status <status>] [--json]
```

Why: creating a gate blocks the task and completes its active dispatch. Resolving a gate sets the task back to `ready` with the resolution context included in the next dispatch preamble.

**Gate statuses**: `pending`, `resolved`, `timeout`.

### Coordinator

Start an automated coordinator loop that dispatches ready tasks, processes `worker_done`/`escalation` messages, and advances the task DAG.

```bash
orca orchestration run --spec <text> [--from <handle>] [--poll-interval-ms <n>] [--max-concurrent <n>] [--worktree <selector>] [--json]
orca orchestration run-stop [--json]
```

Why: `run` returns immediately with a run ID. The coordinator loop runs in the background inside the Orca runtime. Query progress via `orca orchestration task-list`. Only one coordinator can run at a time.

**Coordinator phases**: `decomposing` → `dispatching` → `monitoring` → `merging` → `done`.

### Lifecycle

```bash
orca orchestration reset [--all] [--tasks] [--messages] [--json]
```

Why: `--all` is the default if no flags provided. `--tasks` clears tasks, dispatch contexts, decision gates, and coordinator runs but preserves messages.

### Terminal Commands for Coordinators

Coordinators need these terminal commands to spawn agents, monitor progress, and read output. Full terminal documentation lives in the `orca-cli` skill — this is the subset required for orchestration workflows.

```bash
orca terminal list [--worktree <selector>] [--json]
orca terminal create [--worktree <selector>] [--title <text>] [--command <cmd>] [--json]
orca terminal split --terminal <handle> [--direction horizontal|vertical] [--command <cmd>] [--json]
orca terminal read [--terminal <handle>] [--json]
orca terminal send [--terminal <handle>] --text <text> [--enter] [--json]
orca terminal wait [--terminal <handle>] --for <exit|tui-idle> [--timeout-ms <n>] [--json]
orca terminal show --terminal <handle> [--json]
orca terminal stop [--terminal <handle>] [--json]
orca terminal close [--terminal <handle>] [--json]
```

Why: `--terminal` is optional for most commands. When omitted, Orca auto-resolves to the active terminal in the current worktree.

Why: `--command "claude"` launches Claude Code in the new terminal. After creating a `--command` terminal, use `terminal wait --for tui-idle` to wait for the agent to boot before dispatching.

Why: `--for tui-idle` detects the working→idle OSC title transition for recognized agent CLIs (Claude Code, Gemini, Codex, etc.). Always pass `--timeout-ms` — real coding tasks routinely take 15-60 minutes.

Why: `--direction horizontal` splits left/right (new pane to the right). `--direction vertical` splits top/bottom (new pane below). Default is horizontal.

Why: terminal handles are runtime-scoped. If Orca restarts, handles go stale. Re-acquire with `terminal list`.

Why: the 120-line terminal output buffer (`terminal read`) is for status monitoring, not result extraction. Prefer structured `worker_done` payloads over parsing terminal output.

## Agent Guidance

- When dispatched with a preamble, **always run the `worker_done` command when done**. This is the primary feedback mechanism — it keeps the coordinator's context window clean.
- If blocked or unable to complete a task, send an `escalation` message to the coordinator instead of silently stalling.
- Use `orca orchestration check` to read incoming messages from the coordinator or other agents. Messages are delivered automatically when you go idle, but you can also poll explicitly.
- Treat `orca orchestration` commands the same way you treat `git` or `npm` — they are CLI tools available in your shell.
- The coordinator uses `orca orchestration task-list --ready` as its external memory. Prefer querying orchestration state over tracking it in your context window.
- For multi-agent coordination, prefer the **inter-worktree** pattern (each agent in its own worktree) for parallel implementation tasks. Use **intra-worktree** (split panes, shared files) for complementary tasks where agents don't edit the same files.
- When acting as coordinator: discover existing agents with `terminal list`, create tasks with `task-create`, dispatch with `dispatch --inject`, and wait for `worker_done` messages via `check --wait --types worker_done,escalation --timeout-ms 300000`.
- When acting as coordinator: prefer `check --wait` over sleep+poll loops. `--wait` blocks until a message arrives, eliminating wasted time. Always pass `--timeout-ms` as a safety net. If the wait times out with no messages, fall back to `terminal wait --for tui-idle` and then reading terminal output.
- `check --wait` returns one message at a time. If N workers finish near-simultaneously, call `check --wait` N times in a loop to collect all results. After each return, mark the task complete (which auto-promotes dependents) and dispatch the next wave before looping back to wait.
- After receiving `worker_done` from a terminal, that terminal is guaranteed idle — skip the `terminal wait --for tui-idle` round-trip and dispatch the next task immediately.
- Terminal handles are ephemeral and runtime-scoped. If Orca restarts mid-workflow, all handles go stale. Re-acquire them with `terminal list` before continuing.
- Keep dependency chains to 3-4 steps maximum. Prefer parallel waves of independent tasks over deep sequential chains.
- Insert decision gates (`gate-create`) between phases for human oversight on risky operations.

## Coordinator Worked Example

Dispatch a task to a fresh Claude Code terminal and wait for completion:

```bash
# 1. Create a terminal running Claude Code
orca terminal create --worktree active --title "worker-1" --command "claude" --json
# → handle: term_abc123

# 2. Wait for Claude Code to boot (tui-idle fires when the prompt appears)
orca terminal wait --terminal term_abc123 --for tui-idle --timeout-ms 60000 --json

# 3. Create and dispatch a task with preamble injection
orca orchestration task-create --spec "Fix the login button CSS" --json
# → id: task_def456
orca orchestration dispatch --task task_def456 --to term_abc123 --inject --json

# 4. Block until the worker reports back (no sleep loops needed)
orca orchestration check --wait --types worker_done,escalation --timeout-ms 300000 --json
# → returns immediately when worker sends worker_done

# 5. If --wait timed out with no messages, fall back to idle detection
orca terminal wait --terminal term_abc123 --for tui-idle --timeout-ms 60000 --json
orca terminal read --terminal term_abc123 --json
```
