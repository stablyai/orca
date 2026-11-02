# Placement and remote execution

Folder workspaces are valid. `new-child` and `new-top-level` make Git worktrees
and do not apply to folders; never `git init` a user's folder.

Local `current`, `new-child` and `new-top-level` stay in the caller's project;
`new-child` also uses the caller's workspace as its parent. Omit `--repo` for
same-project work. Pass it only to deliberately target another project, or for
the connected-server creation described below. The project visible in the app
is not the caller's project. For direct `worktree create`, likewise omit
`--repo`/`--project` for same-project work and use `--parent-worktree active`
when requesting a child of the current workspace.

```text
# Child of the current worktree.
ORCA orchestration worker-start --task <task_id> --worktree new-child --agent default --setup run

# On a connected server; the Run stays on yours.
ORCA orchestration worker-start --task <task_id> --on <environment> --worktree new-top-level --repo <exact_remote_repo_selector> --name <name> --agent default --setup run

# On a connected server, nested under your workspace in the sidebar.
ORCA orchestration worker-start --task <task_id> --on <environment> --worktree new-child --repo <exact_remote_repo_selector> --name <name> --agent default --setup run
```

With `--on`, both `new-child` and `new-top-level` need `--repo` naming a
project on that server. `new-child` nests the server's worktree under your
workspace on this machine. A server whose Orca is too old to nest across
machines still starts the worker, top-level, and the receipt's `warning` says
so; the worker is fine to use. `current` is not valid with `--on`.

`--agent default` uses the project that owns the selected workspace or target repository, not the coordinator project. Select an exact `--repo` for cross-project new work; pass an explicit agent ID when the user names one.

`--name` is optional: without it Orca picks a name as it does for an unnamed
workspace, and the start output names the workspace it created.

After start, address a remote worker only by Dispatch ID, never by a terminal
handle.
