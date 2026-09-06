# Coordinator loop

Load this reference for expanded DAG waves, per-invocation launch preferences,
same-terminal reuse, or review ownership. The compact guide remains the source
of truth for the loop order and completion boundary.

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

For a fresh Claude, Codex, or Cursor terminal, `--model` accepts an opaque
provider model ID. Pass it only when the user named a model; otherwise omit it
so the worker inherits the user's configured agent default. Add `--effort` only
when that model supports it:

```text
ORCA orchestration worker-start --task <task_id> --worktree current --agent claude --model opus --effort high --json
```

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
