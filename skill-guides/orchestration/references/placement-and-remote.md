# Placement and remote execution

Folder workspaces are valid. `new-child` and `new-top-level` make Git worktrees,
never in a folder project; never `git init` a user's folder. From a multi-repo
folder workspace, `new-child` nests under the folder and needs `--repo` naming
the Git repo to create the worktree in.

Local `current`, `new-child` and `new-top-level` stay in the caller's project;
`new-child` also uses the caller's workspace as its parent. Omit `--repo` for
same-project Git work. Pass it for a child of a multi-repo folder workspace,
to deliberately target another project, or for connected-server creation. The project visible
in the app is not the caller's project. For direct `worktree create`, likewise omit
`--repo`/`--project` for same-project work and use `--parent-worktree active`
when requesting a child of the current workspace.

```text
# Child of the current worktree.
ORCA orchestration worker-start --environment local --task <task_id> --worktree new-child --agent <agent> --setup run

# On a connected server, nested under your workspace; the Run stays on yours.
ORCA orchestration worker-start --task <task_id> --on <server> --worktree new-child --repo id:<repoId> --name <name> --agent <agent> --setup run

# On a connected server, with no parent.
ORCA orchestration worker-start --task <task_id> --on <server> --worktree new-top-level --repo id:<repoId> --name <name> --agent <agent> --setup run
```

With `--on`, both `new-child` and `new-top-level` need `--repo` naming a
project on that server: `id:<repoId>` from that server's `project setups` row
(see "Which machine" below). `new-child` nests the server's worktree under your
workspace on this machine. A server whose Orca is too old to nest across
machines still starts the worker, top-level, and the receipt's `warning` says
so; the worker is fine to use. `current` is not valid with `--on`.

`--name` is optional: without it Orca picks a name as it does for an unnamed
workspace, and the start output names the workspace it created.

After start, address a remote worker only by Dispatch ID, never by a terminal
handle.

## Which machine

Use this when the user named a machine for this project, now or earlier in
this Run, when the work is for another project, or from a workspace with no
project. Otherwise skip it: `current` and `new-child` already run where you
are.

Steps 1 to 4 choose where a new worktree goes. Work in an existing workspace
skips them, whatever its project's kind, a folder project included. Use your
own with `--worktree current`, or the one the user picked with its exact
worktree selector. Add `--environment local` here or `--on <server>` on a
server, and pass no `--repo`. If that selector does not resolve on that
machine, stop and tell the user. Then record it (step 5).

Only a coordinator places work on another machine. If you are a dispatched
worker, do not pass `--on`: ask your coordinator to place it.

1. Hosts. `ORCA host list --json`: `kind: local` is the machine your CLI runs
   on, `kind: environment` is a paired server (`--on <name>`, or its id when
   two servers share a name). A name the user gave that matches more than one
   row, such as an SSH target and a server, is not resolved: ask which.

2. Where the project is. A listing covers only the Orca that answers it, so ask
   each one, the servers together in one shell command:

   ```text
   ORCA project setups --environment local --json      # this machine
   ORCA project setups --environment <id> --json       # once per paired server
   ```

   `--environment local` pins a command to this machine whatever
   `ORCA_ENVIRONMENT` or a pairing code in your shell selects; without it, that
   read can be answered by a server and look like this machine's. `<id>` is the
   `id` of that server's `kind: environment` row. Do not add
   `--host runtime:<id>`: it drops the server's SSH rows. If `ORCA_PAIRING_CODE`
   or `ORCA_REMOTE_PAIRING` is set in your shell, unset it for the server reads.

   Match the project by `projectId` (such as `github:owner/repo`); a name must
   match one project id across every answer, or you ask. A `repo:<…>` id exists
   on one host only. A row is usable for a new worktree when `setupState` is
   `ready`, `repoId` is not empty, `kind` is not `folder`, and `hostId` is
   `local` (the machine that answered). Another `local` row is registered but
   not usable. A row with any other `hostId` describes an SSH target: a start
   cannot create a worktree there.

   Only a complete, successful list shows the project is absent on that
   machine. A server whose read fails is unchecked, with its reason:
   `remote_runtime_unavailable`, `runtime_timeout`,
   `runtime_environment_asleep`, `incompatible_runtime`, or a refused or
   cut-off answer. An `invalid_argument` about your selector is not an answer:
   fix the command first.

3. Decide. The first line that applies wins, and a line that says stop or ask
   ends the decision. A retry of an attempt that ran on a server is limited to
   two machines: that server and, once that attempt is settled, this one.
   Apply the lines to those two only. That attempt counts as your Run having
   placed the project on that server, and there you keep that attempt's repo.
   - The user named a machine, now or earlier in this Run for this project:
     use it, and the repo chosen with it. If that is no longer usable there,
     or the machine cannot be checked, stop and tell the user. Never
     substitute another machine or repo.
   - Your Run already placed this project, that machine and repo are still
     usable, and this machine has not become usable since: use the same
     machine and repo.
   - Usable on this machine: stay here, with `--environment local` and no
     `--on`.
   - Registered on this machine but not usable: stop and tell the user. Do not
     move it to a server.
   - Usable on exactly one paired server: start there with `--on`; do not wait
     for the user to name it.
   - Usable on several paired servers: ask the user once, naming each; keep
     the answer for the Run.
   - Usable nowhere, but registered somewhere (not ready, no checkout, or only
     on an SSH target): do not start it. Tell the user where it is registered
     and why it cannot be used.
   - Usable nowhere, and a server was unchecked: do not treat it as absent.
     Tell the user which servers you could not check and ask whether to go
     ahead here.
   - Registered nowhere, and every machine answered: place it as you would
     have without this section, and say in your report that no machine has it
     set up.

4. Selector. For a new worktree (`new-child` or `new-top-level`), take `repoId`
   from the chosen machine's own row and pass `--repo id:<repoId>`. Never reuse
   an id, path or name from another machine's row. If the user, or an earlier
   start in this Run, already chose a repo on that machine, use that exact repo
   while its row is still usable and do not ask again. Otherwise, with several
   usable rows there, use the one whose `path` or `displayName` the user named,
   else ask. Every start here carries `--environment local`, whichever line
   chose this machine; every start on a server carries `--on`.

5. Record it. For a new Task (`--spec`), write the task first, because the
   spec's first line becomes its title, then end the spec with a line of its
   own, either a line break inside the quotes or the last line of a
   `--spec-file`:

   ```text
   --spec "<task>
   Placement: <machine name> (<kind> <id>), <reason>."
   ```

   This machine is `this machine (local)`.

   `<reason>` is one of: the user named it; set up on this machine; the only
   ready candidate; the only known ready candidate (a server was unchecked);
   this Run already works there; no machine has it set up; the user chose to
   go ahead here with a server unchecked. Put what you checked on the other
   machines in your report to the user, not in the spec. An existing Task
   (`--task`, `--retry-of`) takes no new spec: give the machine, the reason and
   the new Dispatch ID in your report instead.

A worker on another machine has that machine's checkout, credentials and agents,
not yours. Push the branch or name the commit it needs; keep secrets, and paths
of files that exist only here, out of the spec. The listing cannot prove a
worker can start there. If the start is refused or the server does not answer,
report it; do not try another machine.

## Agents on another server

To message an agent that already runs on a paired server, send with `--on`,
using the same server names as `worker-start --on`:

```bash
ORCA orchestration send --on <server> --to <term_…|orca_session_id:…|bot:<name>> --type status|handoff|question|dispatch|merge_ready --subject "<text>" --body "<text>"
```

`--on` carries ordinary mail only. `escalation`, `decision_gate`, `worker_done`
and `heartbeat` belong to a Dispatch: send them without `--on`, from that
Dispatch, as you would on one computer.

A bot there takes only `status`, `handoff` or `question`, plus
`--chat <id|new>` and `--item <n>` as it does on its own computer, and treats
the request as its owner's.

Your own Orca carries the mail and keeps the conversation. Replies come back to
your own mailbox and wake you like local mail. The other agent answers
with a plain `reply --id <msg_id> --body <text>`; no flag is needed on either
side. Mail from another server names its sender as `<sender> on <server name>`.

`--environment <server>` runs one command on that server and delivers nothing back
to you, so an agent never mails with it. Your mailbox stays on your own Orca:
`check` takes no `--environment`. Read-only commands such as `inbox` or
`worker-list` with `--environment` show that server's records. A server whose Orca
is too old answers `server_mail_unsupported` and nothing is sent. Pair servers
with `orca pair` or in Settings.
