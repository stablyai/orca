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

Unless the user or the task names one, omit `--agent`, `--model`, and
`--effort`. Omitted fields inherit the user's configured Settings >
Orchestration Worker defaults, which is the correct launch for ordinary work:

```text
ORCA orchestration worker-start --task <task_id> --worktree current --json
```

Pass a flag only when the user named that choice or the task requires a
specific agent's unique capability. For a fresh Claude, Codex, or Cursor
terminal, `--model` accepts an opaque provider model ID; add `--effort` only
when that model supports it:

```text
ORCA orchestration worker-start --task <task_id> --worktree current --agent claude --model opus --effort high --json
```

Quality, depth, thoroughness, or meticulousness language is not a request for a
specific agent, model, or effort; treat it as one only when the user names an
agent, model, or effort level. Your own quality judgment — results seem
shallow, a deeper second pass or a retry seems useful, a stronger model seems
preferable — never authorizes overriding the user's defaults, including for a
deep second pass, retry, or verification. If a stronger model or effort is
genuinely needed, stop and ask the user directly in your own turn, then wait
for the answer; there is no CLI path for this, because `ask` is
worker-to-coordinator and fails with `dispatch_inactive` from a coordinator,
while a decision gate records a coordinator-managed DAG decision rather than
reaching the user. Mix agents only when the user requests multiple agents or
the task specifies them, never for coordinator-chosen diversity.

If `worker-start` fails with `agent_unconfigured`, no default worker agent is
configured and you have no basis to pick one: stop and ask the user which agent
to launch, the same way you would for a stronger model or effort, then retry
with their answer as an explicit `--agent`. Never resolve `agent_unconfigured`
by choosing an agent yourself, and tell the user to set a default worker agent
in Settings > Orchestration so later launches stay flag-free. This is
missing-configuration recovery, not permission to override defaults.

`--effort` requires `--model`; neither option combines with `--terminal`, and
reusing a terminal does not inject the configured worker defaults. A connected
worker server must advertise launch-preference support before Orca forwards
either field. Compare `launch.requested` with `launch.effective`; never claim a
model or effort from requested arguments alone.

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
