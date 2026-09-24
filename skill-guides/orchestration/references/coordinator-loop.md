# Coordinator loop

Load this reference for coordinating from a chat session, expanded DAG waves,
per-invocation launch preferences, same-terminal reuse, or review ownership. The compact guide remains the source
of truth for the loop order and completion boundary.

## Coordinating from a chat session

When `ORCA status --json` reports `caller.kind` `session`, you coordinate from a
chat. Never block in `check --wait`: your shell tool has its own timeout, and
Orca wakes you instead. Orca refuses it with `wait_requires_terminal` while the
session runs as a chat; only its terminal view may wait. When messages reach your Run, Orca starts a new turn in
this chat once you are idle, saying `You have <n> orchestration message(s)` and
naming the `check` to run.

1. Bind one Run and start the full independent wave.
2. End your turn.
3. On each such turn run the `check` it names, without `--wait`. Process every
   message as the compact guide requires, then acknowledge with
   `ORCA orchestration check --ack <delivery_id> --json`, which also returns the
   next batch. Repeat until no Delivery is returned.
4. End your turn again. When every expected Dispatch has settled, report.

A turn with no new Delivery is a checkpoint, not a failure. The compact guide's
empty-wait enumeration applies when a turn arrives and a Dispatch you expected
has still not settled. Your address survives `/clear`; nothing moves, and your
Runs and unread mail stay where they are.

## Ready waves

Create independent Tasks before the first wait. Encode only real dependencies,
then use the ready view as external memory:

```text
ORCA orchestration task-create --spec "<dependent work>" --deps <json_array> --json
ORCA orchestration task-list --ready --brief --json
```

`--brief` collapses whitespace and caps echoed specs at 160 characters;
`spec_truncated` identifies shortened rows. Omit it when full specs are needed or
when an older CLI rejects the flag. A nested worker must respect
`nested_worker_depth_exceeded`; creating another Run does not reset depth.

## Launch preferences

For a fresh Claude, Codex, Cursor, Antigravity, or Muse terminal, `--model`
accepts an opaque provider model ID. Pass it only when the user named a model;
otherwise omit it so the worker inherits the user's configured agent default.
Add `--effort` only when that model supports it:

```text
ORCA orchestration worker-start --task <task_id> --worktree current --agent claude --model opus --effort high --json
ORCA orchestration worker-start --task <task_id> --worktree current --agent muse --model muse-spark-1.3 --json
```

Other agents, including `opencode`, reject `--model`; they run the model set in
their own config, so a coordinator wanting a same-model opencode worker relies
on that config.

`--effort` requires `--model`; neither option combines with `--terminal`. A
connected worker server must advertise launch-preference support before Orca
forwards either field. Compare `launch.requested` with `launch.effective`; never
claim a model or effort from requested arguments alone.

## Reuse after settlement

Choose the terminal's next owner before acknowledging the Delivery. When the
same exact agent has immediate follow-up work, recover the proven handle and
transfer cleanup ownership to the new Dispatch:

```text
ORCA orchestration worker-show --dispatch <dispatch_id> --json
ORCA orchestration worker-start --task <next_task_id> --terminal <agent_terminal_handle> --json
```

Otherwise explicitly retain or release the settled worker. Do not leave it live
only to inspect output; archived output remains available through `worker-read`.

## Review ownership

A review-only `worker_done` authorizes synthesis of findings, not coordinator
file edits. Dispatch or hand off fixes unless the user explicitly assigned them
to the coordinator. If the user's plan names a next owner, post-review fixes and
PR preparation remain with that owner; the coordinator routes and synthesizes.
