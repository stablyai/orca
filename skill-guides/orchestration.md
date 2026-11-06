---
name: orchestration
description: >-
  Run work in separate Orca worker agents and get their results back. Use when
  the user asks for Orca workers or supervision (monitor, task DAGs, ask/reply,
  decision gates), or when the work needs something your own subagents cannot
  give: a different agent (such as Codex from Claude) or its own Orca workspace.
  "Have Codex (or Claude) review this and report back" means an Orca worker of
  that agent, even when you have your own model subagents.
  Also use when you are a dispatched worker (a prompt with Task and Dispatch
  IDs: ask, worker_done). Otherwise prefer your own subagents,
  including for long or parallel work. Use `orca-cli` to hand work off with
  nothing expected back ("hand off", "handover", "give this to another agent",
  "another worktree"), and for terminal control, shell commands, worktree
  management, and reading or waiting on terminals.
---

# Orca orchestration

If your prompt has a preamble with Task and Dispatch IDs, you are a worker:
follow the preamble. To ask your coordinator, run `ask`, then end your turn;
Orca wakes you with the answer. To hand work off with nothing back, use `orca-cli`.

## Recipe

`ORCA` stands for the executable you used to run `skills get`; type it in its
place and use it for every command.

```text
ORCA orchestration worker-start --spec "<task>" --worktree current --agent codex
```

- Start every independent worker, then **end your turn**. "Report back" and
  "tell me when it's done" still mean end your turn; Orca wakes you and you
  report then.
- If a receipt has `next`, follow it. When Orca has nothing for you, end your
  turn.
- `--worktree current` uses your workspace. Use a new one only when the user
  asks or sharing would conflict:
  `--worktree new-top-level --repo id:<repoId> --name <short-name>`
  (`ORCA repo list --json` gives the id). If nothing needs to come back to you
  (the user will work in those chats), don't start workers; per workspace run
  `ORCA worktree create --name <name> --no-parent --agent <agent> --prompt "<brief>" --json`
  and end your turn.
- Add `--model` only if the user named one.
- If `worker-start` fails, do not rerun it; read `failedStage` and load
  `references/recovery-and-cleanup.md`.
- To talk to a worker, use
  `ORCA orchestration send --to dispatch:<dispatch_id> --subject "<topic>" --body "<message>"`
  in any state: a working worker gets it when its current turn ends; a finished
  or closed one gets it as a follow-up Task and reports with `worker_done`. The
  receipt says which.
  Except on a paired server: a finished worker there refuses `send`, so start
  new work there with `worker-start --on <server>` (load
  `references/placement-and-remote.md` first).

Never:

- Poll or run watch scripts: a script's plain `check` takes your mail, so it is
  hidden from you and Orca has nothing to wake you with. Orca wakes you.
- Steer through a worker's terminal; use `send`.
- Make checkouts yourself; let `worker-start` create a worker's workspace.

## When Orca wakes you

- In a chat, each message arrives whole as its own message: act on it. A wake
  that names a `check` command (a terminal, or one message too large for a chat
  message) means run that command. Answer a `question` with
  `ORCA orchestration reply --id <message_id> --body "<answer>"` when the answer
  follows from the task or the user's instructions; otherwise ask the user first.
- An `escalation` with `stopReason` means the worker stopped without
  `worker_done`: steer it with `send`, stop and retry it, or tell the user.
- A `worker_done` settles its Task; never mark a reported failure completed.
- When every worker has settled, report to the user per Task: outcome,
  evidence, open blockers.
- Lost track? `ORCA orchestration inbox --terminal run:<run_id> --limit 50`
  shows mail `check` already handled.

Finished workers close on their own unless `worker-list` gives one a `next`; follow
it. Kept-open workers, including new-workspace ones, stay open for the user.
`send` reopens a closed worker when you need it again.
Start a worker in your workspace with `--keep-open` when the user will keep using
its chat after it reports: they want to watch it or talk to it. To keep one already
started, run
`ORCA orchestration worker-keep-open --dispatch <dispatch_id>`.

## Scheduled waits

For a long-lived task that deliberately rests until an automation or scheduled wake,
report before ending the turn:

```text
ORCA orchestration send --type status --subject "Waiting for next check" --wait-until 4h --body "Next scheduled PR check" --from <worker_handle> --dispatch-id <dispatch_id>
```

`--wait-until` accepts a future ISO timestamp with timezone or a duration (`30s`,
`5m`, `4h`, `1d`). The body is the required reason. Confirm the receipt includes
`scheduledWait` before relying on it. The wait persists across Orca restarts and
suppresses only a clean idle-stop escalation for that exact Dispatch until its
deadline. Errors, approval prompts, and process exits still report. A missed
deadline without progress reports once. A new turn or later status without
`--wait-until` clears the wait; declare it again before resting another time.
This records a deadline; it does not create a wake automation. Keep the Task open
and use `worker_done` only when the assigned work has finished. `--keep-open`
alone does not declare a scheduled wait.

## Task spec

Make each spec self-contained: the target, the change, constraints, what the
worker may edit, and the evidence that proves it is done. Say whether a
non-zero exit means the Task failed or capturing it is the deliverable. Send
fixes to a worker unless the user gave them to you.

Fetch this guide once. Summarize the worker's evidence; rerun checks only for a
gap or contradiction.

## Safety

Silence, a timeout, or `unverifiable` liveness alone never proves exit or authorizes
autonomous recovery. For explicit user cancellation or assignment abandonment,
load `references/recovery-and-cleanup.md`: requesting a guarded stop or fencing an
assignment does not prove its agent stopped.

## References

`ORCA skills get orchestration --reference references/<file>.md`

| Situation                                      | Reference                            |
| ---------------------------------------------- | ------------------------------------ |
| Task DAGs, several Runs                        | `references/coordinator-loop.md`     |
| Child worktrees, SSH, WSL, a connected server  | `references/placement-and-remote.md` |
| Group messages                                 | `references/messaging-and-gates.md`  |
| A failed or unknown worker; retry, stop, reset | `references/recovery-and-cleanup.md` |
| Custom argv or terminal layout                 | `references/low-level-topology.md`   |
