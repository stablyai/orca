# ClickUp Integration

Orca can use ClickUp as a task source in the desktop app, through a paired
mobile client, and from the `orca clickup` CLI. A ClickUp task can also be
linked to an Orca workspace so its context follows the worktree.

## Connect ClickUp

1. In ClickUp, create a Personal API token from **Settings → Apps**.
2. In Orca, open **Settings → Integrations → ClickUp**.
3. Paste the token and select one Workspace, or select all accessible
   Workspaces.

Personal tokens inherit the ClickUp account's permissions. Orca loads every
ClickUp Workspace the token can access, so use an account with the intended
scope.

The connection belongs to the runtime that performs the work. Connect ClickUp
on the local, WSL, SSH, or relay runtime where tasks will be queried; credentials
are not silently copied between hosts. Orca uses Electron `safeStorage`
encryption when the host supports it. If encryption is unavailable, it writes
the token to a host-local file with owner-only permissions and emits a warning.
Tokens are never included in CLI output.

## Desktop and Mobile

Select **ClickUp** from the Tasks source picker to:

- filter assigned, created, open, completed, or all tasks;
- search one Workspace or all connected Workspaces;
- inspect descriptions, assignees, tags, status, due date, and comments;
- create tasks in a selected ClickUp List;
- update a task and start a linked Orca workspace.

A paired mobile client uses the selected runtime's ClickUp connection. This
keeps SSH and remote behavior consistent with the desktop app: the runtime that
answers the mobile RPC owns the credential and performs the ClickUp request.

When a ClickUp task is linked to an Orca workspace, the task reference appears
in workspace context. Board moves can update ClickUp only when the destination
maps to an exact status name available on that task's List; Orca does not guess
between ambiguous statuses.

## CLI

Check the live command surface before automation:

```bash
orca status --json
orca clickup --help
orca clickup workspace list --json
```

On Linux, use `orca-ide` in place of `orca`.

Read and discover tasks:

```bash
orca clickup task --current --json
orca clickup task 86abc123 --workspace 12345 --json
orca clickup search "authentication bug" --workspace all --limit 10 --json
orca clickup list --filter assigned --workspace all --limit 20 --json
orca clickup destination list --workspace 12345 --json
```

Update or create tasks:

```bash
orca clickup status set --current --to "in review" --json
orca clickup priority set 86abc123 --to high --json
orca clickup due-date set 86abc123 --to 2026-07-31 --json
orca clickup comment add --current --body "Ready for review." --json
orca clickup create --list 90123 --title "Investigate flaky login" --json
```

Task commands accept a ClickUp task ID or an
`https://app.clickup.com/t/<id>` URL. `--current` resolves the task linked to
the active worktree; launcher-created sessions can use `ORCA_WORKTREE_ID` when
the current directory no longer identifies that worktree. Prefer `--json` for
agent and script use.

Link an existing workspace or create a linked one:

```bash
orca worktree set --worktree active --clickup-task 86abc123 --clickup-workspace 12345 --json
orca worktree create --name auth-fix --clickup-task 86abc123 --clickup-workspace 12345 --json
```

## Development macOS Build

The fork-only `Development macOS Build` workflow runs for pushes to
`clickup-issues` in `luizeof/orca`. It builds unsigned Apple Silicon and Intel
packages on `macos-15` and uploads the DMG and ZIP files as a single workflow
artifact retained for seven days.

To test a local checkout on a Mac:

```bash
pnpm install --frozen-lockfile
pnpm verify:macos-entitlements
pnpm build:mac
```

Unsigned development builds may require macOS to confirm the first launch.
Release signing and notarization are intentionally outside this personal test
workflow.

## Troubleshooting

- **No connected account:** connect the Personal API token on the runtime that
  is currently selected.
- **No Workspace or List:** confirm the token owner can access it, refresh the
  connection, and use `workspace list` or `destination list` to obtain stable
  IDs.
- **Task not found:** pass the task's Workspace with `--workspace`, especially
  when multiple Workspaces are connected.
- **Status update rejected:** use the exact status name configured on the
  task's ClickUp List.
- **Remote request times out:** verify the SSH or relay runtime is online before
  retrying. Writes should not be reported as successful unless Orca confirms
  them.
