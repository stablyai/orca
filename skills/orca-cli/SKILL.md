---
name: orca-cli
description: Use the Orca CLI to orchestrate worktrees and live terminals through a running Orca editor. Use when an agent needs to create, inspect, update, or remove Orca worktrees; inspect repo state known to Orca; or read, send to, wait on, or stop Orca-managed terminals. Triggers include "use orca cli", "manage Orca worktrees", "read Orca terminal", "reply to Claude Code in Orca", "create a worktree in Orca", or any task where the agent should operate through Orca instead of talking to git worktrees and terminal processes directly.
---

# Orca CLI

Use this skill when the task should go through Orca's control plane rather than directly through `git`, shell PTYs, or ad hoc filesystem access.

## When To Use

Use `orca` for:

- worktree orchestration inside a running Orca app
- reading and replying to Orca-managed terminals
- stopping or waiting on Orca-managed terminals
- accessing repos known to Orca

Do not use `orca` when plain shell tools are simpler and Orca state does not matter.

Examples:

- creating one Orca worktree per GitHub issue
- finding the Claude Code terminal for a worktree and replying to it
- checking which Orca worktrees have live terminal activity

## Preconditions

- Prefer the public `orca` command first
- Orca editor/runtime should already be running, or the agent should start it with `orca open`
- Do not begin by inspecting Orca source files just to decide how to invoke the CLI. The first step is to check whether the installed `orca` command exists.

First verify the public CLI is installed:

```bash
command -v orca
```

Then use the public command:

```bash
orca status --json
```

If the task is about Orca worktrees or Orca terminals, do this before any codebase exploration:

```bash
command -v orca
orca status --json
```

If `orca` is not on PATH, say so explicitly and stop or ask the user to install/register the CLI before continuing.

## Core Workflow

1. Confirm Orca runtime availability:

```bash
orca status --json
```

If Orca is not running yet:

```bash
orca open --json
orca status --json
```

2. Discover current Orca state:

```bash
orca worktree ps --json
orca terminal list --json
```

3. Resolve a target worktree or terminal handle.

4. Act through Orca:

- `worktree create/set/rm`
- `terminal read/send/wait/stop`

## Command Surface

### Repo

```bash
orca repo list --json
orca repo show --repo id:<repoId> --json
orca repo add --path /abs/repo --json
orca repo set-base-ref --repo id:<repoId> --ref origin/main --json
orca repo search-refs --repo id:<repoId> --query main --limit 10 --json
```

### Worktree

```bash
orca worktree list --repo id:<repoId> --json
orca worktree ps --json
orca worktree show --worktree id:<worktreeId> --json
orca worktree create --repo id:<repoId> --name my-task --issue 123 --comment "seed" --json
orca worktree set --worktree id:<worktreeId> --display-name "My Task" --json
orca worktree rm --worktree id:<worktreeId> --force --json
```

Worktree selectors supported in focused v1:

- `id:<worktree-id>`
- `path:<absolute-path>`
- `branch:<branch-name>`
- `issue:<number>`

### Terminal

Use selectors to discover terminals, then use the returned handle for repeated live interaction.

```bash
orca terminal list --worktree id:<worktreeId> --json
orca terminal show --terminal <handle> --json
orca terminal read --terminal <handle> --json
orca terminal send --terminal <handle> --text "continue" --enter --json
orca terminal wait --terminal <handle> --for exit --timeout-ms 5000 --json
orca terminal stop --worktree id:<worktreeId> --json
```

Why: terminal handles are runtime-scoped and may go stale after reloads. If Orca returns `terminal_handle_stale`, reacquire a fresh handle with `terminal list`.

## Agent Guidance

- If the user says to create/manage an Orca worktree, use `orca worktree ...`, not raw `git worktree ...`.
- Treat Orca as the source of truth for Orca worktree and terminal tasks. Do not mix Orca-managed state with ad hoc git worktree commands unless Orca explicitly cannot perform the requested action.
- Prefer `--json` for all machine-driven use.
- Use `worktree ps` as the first summary view when many worktrees may exist.
- Use `terminal list` to reacquire handles after Orca reloads.
- Use `terminal read` before `terminal send` unless the next input is obvious.
- Use `terminal wait --for exit` only when the task actually depends on process completion.
- Prefer Orca worktree selectors over hardcoded paths when Orca identity already exists.
- If the user asks for CLI UX feedback, test the public `orca` command first. Only inspect `src/cli` or use `node out/cli/index.js` if the public command is missing or the task is explicitly about implementation internals.
- If a command fails, prefer retrying with the public `orca` command before concluding the CLI is broken, unless the failure already came from `orca` itself.

## Important Constraints

- Orca CLI only talks to a running Orca editor.
- Terminal handles are ephemeral and tied to the current Orca runtime.
- `terminal wait` in focused v1 supports only `--for exit`.
- Orca is the source of truth for worktree/terminal orchestration; do not duplicate that state with manual assumptions.
- The public `orca` command is the interface users experience. Agents should validate and use that surface, not repo-local implementation entrypoints.

## References

See these docs in this repo when behavior is unclear:

- `docs/orca-cli-focused-v1-status.md`
- `docs/orca-cli-v1-spec.md`
- `docs/orca-runtime-layer-design.md`
