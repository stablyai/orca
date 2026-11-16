---
name: orchestration
description: >-
  Run work in separate Orca worker agents and get their results back. Use when
  the user invokes /orchestration, asks for Orca workers or supervision
  (monitor, task DAGs, ask/reply, decision gates), or asks to split,
  parallelize or fan out code changes across agents, worktrees or branches;
  use Orca workers for those. Also use when the work needs a different agent
  (such as Codex from Claude) or its own Orca workspace: "Have Codex (or
  Claude) review this and report back" means an Orca worker of that agent.
  Also use when you are a dispatched worker (a prompt with Task and Dispatch
  IDs: ask, worker_done). Unless the user asks for Orca workers or a named
  agent, searches, reads and research in your workspace stay with your own
  subagents, even in parallel. Use `orca-cli` to hand work off
  with nothing expected back ("hand off", "handover", "give this to another
  agent", "another worktree"), and for terminal control, shell commands,
  worktree management, and reading or waiting on terminals.
---

# Orca orchestration

If your prompt has a preamble with Task and Dispatch IDs, you are a worker:
follow the preamble. To ask your coordinator, run `ask`, then end your turn;
Orca wakes you with the answer. To hand work off with nothing back, use `orca-cli`.
When you report your effort, take it from the dispatch's `--effort` or your process
argv, not from a numeric `reasoning_effort`: that number is not on a 0–100 scale
(claude-opus-5-5: low=5, medium=10, high=15, xhigh=40).

## Prepare command input

`ORCA` stands for the executable you used to run `skills get`; type it in its
place and use it for every command.

For all multiline content, use a file write/edit tool to create a UTF-8 file,
then pass the command's documented file option. This includes creating files,
worker specs, orchestration send/reply bodies, git commit messages, and PR/comment
bodies. Never use heredocs or here-strings, including cat/python wrappers or
command substitutions: they can hang in the shell before the command starts.
Never insert arbitrary file contents into shell source. For short input, use
plain argv quoted for the current shell.

After writing the files with your file tool:

```text
ORCA orchestration worker-start --spec-file "<task-file>" --worktree current --agent <agent>
ORCA orchestration send --to dispatch:<dispatch_id> --subject "<topic>" --body-file "<body-file>"
ORCA orchestration reply --id <msg_id> --body-file "<answer-file>"
git commit -F "<message-file>"
gh pr create --body-file "<body-file>"
```

File paths belong to the CLI's execution host. For a remote command that only
accepts stdin, use its documented file copy/redirect mechanism, never a heredoc.
Keep each input file unchanged until the operation and any recovery are resolved.
Keep the mutation UUID separate from the answered-to `msg_…` id. If send, reply,
or worker-start fails or times out, follow the recovery commands the CLI prints,
exactly, with the same request UUID and unchanged body or spec file. To check,
use the CLI's query (`worker-show` for dispatch-scoped work):

```text
ORCA orchestration request-show --request <mutation-UUID> --json
ORCA orchestration worker-show --dispatch <dispatch-id> --json
```

Use the same caller and receipt host; retain any `--on <server>` shown by the CLI's
recovery query. If the CLI printed that the request was not sent, follow its printed
retry command. Otherwise, if the receipt is absent, expired, or inconclusive, do not
resend; tell your owner. Never resend with a fresh UUID.

## Recipe

```text
ORCA orchestration worker-start --spec "<task>" --worktree current --agent <agent>
```

`<agent>` is an Orca agent id: one the user named, else the agent you are
running as when the worker shares your execution host. Otherwise, such as a
different SSH/WSL host or `--on`, ask the user. `worker-start` does not check
that the CLI is installed; a missing one fails as an `agent_readiness` timeout.

- Start independent workers at the same time, up to about 4 at once, and
  start the rest as those return. Separate tool calls often run one after
  another, so start each group from one shell command: load
  `references/parallel-start.md` for the POSIX and PowerShell forms.
  Then **end your turn**. "Report back" and
  "tell me when it's done" still mean end your turn; Orca wakes you and you
  report then.
- If a receipt has `next`, follow it. When Orca has nothing for you, end your
  turn.
- `--worktree current` uses your workspace. Use a new one only when the user
  asks or sharing would conflict: `--worktree new-child --name <short-name>`
  nests it under yours. For one with no parent, use
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
  `exited` or `lost` means it is gone: retry it or tell the user.
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
| Several independent workers at once            | `references/parallel-start.md`       |
| Custom argv or terminal layout                 | `references/low-level-topology.md`   |
