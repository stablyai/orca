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
ORCA orchestration worker-start --spec "<task>" --worktree current --agent codex --json
```

- Start every independent worker, then **end your turn**. "Report back" and
  "tell me when it's done" still mean end your turn; Orca wakes you and you
  report then.
- If a receipt has `next`, follow it. When Orca has nothing for you, end your
  turn.
- `--worktree current` uses your workspace. Use a new one only when the user
  asks or sharing would conflict:
  `--worktree new-top-level --repo id:<repoId> --name <short-name>`
  (`ORCA repo list --json` gives the id).
- Add `--model` only if the user named one.
- If `worker-start` fails, do not rerun it; read `failedStage` and load
  `references/recovery-and-cleanup.md`.
- To steer a worker, use
  `ORCA orchestration send --to dispatch:<dispatch_id> --subject "<topic>" --body "<guidance>"`.

Never:

- Poll or run watch scripts: a script's plain `check` takes your mail, so it is
  hidden from you and Orca has nothing to wake you with. Orca wakes you.
- Steer through a worker's terminal; use `send`.
- Make checkouts yourself; let `worker-start` create a worker's workspace.

## When Orca wakes you

- Run the `check` command the wake gives you. Answer each `question` with
  `ORCA orchestration reply --id <message_id> --body "<answer>" --json`.
- An `escalation` with `stopReason` means the worker stopped without
  `worker_done`: steer it with `send`, stop and retry it, or tell the user.
- A `worker_done` settles its Task; never mark a reported failure completed.
- When every worker has settled, report to the user per Task: outcome,
  evidence, open blockers.
- Lost track? `ORCA orchestration inbox --terminal run:<run_id> --limit 50 --full --json`
  shows mail `check` already handled.

Finished workers close on their own unless the user chose Keep open. To keep one
for a follow-up, run `ORCA orchestration worker-retain --dispatch <dispatch_id> --json`.
If `worker-list` shows no `autoReleaseAt` for a finished worker, release it yourself.

## Task spec

Make each spec self-contained: the target, the change, constraints, what the
worker may edit, and the evidence that proves it is done. Say whether a
non-zero exit means the Task failed or capturing it is the deliverable. Send
fixes to a worker unless the user gave them to you.

Fetch this guide once. Summarize the worker's evidence; rerun checks only for a
gap or contradiction.

## Safety

Stop, retry, or abandon a worker only on proof its agent stopped; silence or an
`unverifiable` reading proves nothing.

## References

`ORCA skills get orchestration --reference references/<file>.md`

| Situation                                      | Reference                                 |
| ---------------------------------------------- | ----------------------------------------- |
| Task DAGs, several Runs, reusing a worker      | `references/coordinator-loop.md`          |
| Child worktrees, SSH, WSL, a connected server  | `references/placement-and-remote.md`      |
| Group messages, inbox scripts                  | `references/messaging-and-gates.md`       |
| A failed or unknown worker; retry, stop, reset | `references/recovery-and-cleanup.md`      |
| Custom argv or terminal layout                 | `references/low-level-topology.md`        |
| Legacy labels, adopted Runs, takeover          | `references/legacy-contract-migration.md` |
