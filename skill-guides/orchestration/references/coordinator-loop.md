# Coordinator loop

## Task DAGs

A Task needs a Run, so create one first. Workers editing the same files at once
need separate workspaces.

```text
ORCA orchestration run-create --objective "<goal>"
ORCA orchestration task-create --spec "<dependent work>" --deps <json_array>
ORCA orchestration task-list --ready --brief
ORCA orchestration worker-start --task <task_id> --worktree current --agent codex
```

On every wake, start the Tasks `task-list --ready` shows.

## Several Runs

A later `run-create` keeps your earlier Runs: their mail still wakes you, but
commands without `--run` use the newest Run, so pass `--run <id>` for an earlier
one. `run-use` keeps only the Run it names.

For a fresh Claude, Codex, Cursor, Antigravity, or Muse terminal, `--model`
accepts an opaque provider model ID. Pass it only when the user named a model;
otherwise omit it so the worker inherits the user's configured agent default.
Add `--effort` only when that model supports it:

```text
ORCA orchestration worker-start --task <task_id> --worktree current --agent claude --model opus --effort high --json
ORCA orchestration worker-start --task <task_id> --worktree current --agent muse --model muse-spark-1.3 --json
```

OpenCode also accepts `--model` in an existing worktree when the execution host
verifies its CLI version and model availability. Creating a new worktree with an
OpenCode model override is unsupported; use `--worktree current` or an existing
worktree selector, or omit `--model`. OpenCode effort is unsupported. Omit the
model to inherit its configuration; unsupported or unknown hosts refuse the
override explicitly.

`--effort` requires `--model`; neither option combines with `--terminal`. A
connected worker server must advertise launch-preference support before Orca
forwards either field. Compare `launch.requested` with `launch.effective`; never
claim a model or effort from requested arguments alone.

## Configured worker roles

When the user names a saved worker role, use `--role <name>` instead of guessing
an agent or model. The user configures profiles in Settings → Orchestration →
Worker roles on the Run home. Initial names are research, implementation, and
review; an unassigned or unknown role is refused before Task creation.

```text
ORCA orchestration worker-start --spec "<approved implementation>" --worktree current --role implementation --json
ORCA orchestration worker-start --spec "<independent review>" --worktree current --role review --json
```

Explicit `--model`, `--effort`, and `--fast on|off` replace profile values. An
explicit different `--agent` clears inherited model, effort, and Fast; repeat
the intended options for that provider. Roles never combine with `--terminal`.
Claude/Codex Fast requires the configured Chat UI route, an existing workspace,
and verified model/account catalog support; terminal Fast follows its launch
catalog. A refusal never authorizes a different harness, host, or provider.

Role/Fast launches require `orchestration.worker-role-routing.v1` on both hosts.
The execution server preflights the resolved choices before the Run home creates
a Task/Dispatch. A missing remote receipt after attachment is outcome unknown,
not permission to launch a duplicate. Read `launch.role` and `launch.effective`;
`effectiveSource: launch_configuration` describes emitted configuration, not a
promise about provider execution, cost, quota, or billing. Role choices do not
alter existing concurrency limits or trigger automatic retries.
