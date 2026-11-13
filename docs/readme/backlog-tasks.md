# Backlog.md in Tasks

Select **Tasks → Backlog.md**, then choose a project and execution host. Git repositories
without a hosting provider and folder projects are both supported. Search matches IDs,
titles and task bodies; status filters use the project's configured status names. Details
show the complete Markdown body, including acceptance criteria, plan and notes.

Reading requires an initialized Backlog.md project, not an account or CLI installation.
Orca recognizes `backlog.config.yml` (including `backlog_directory`), `backlog/config.yml`
and `.backlog/config.yml`, with `config.yaml` accepted for folder-local configuration.
Only active tasks in the selected checkout's `tasks` directory are listed; drafts,
archived/completed files and tasks on other Git branches are not merged into this view.

## Create and edit

Install **`backlog.md@1.48.0` as a pinned project dependency** on the execution host.
Orca invokes that project's `node_modules/backlog.md/cli.js` directly, with separate
arguments, a timeout and bounded output. It never invokes `npx`, downloads packages,
uses a global CLI or writes task Markdown itself. Other CLI versions remain read-only
until their command contract is validated. Missing or unsupported installations are
explained inline without preventing browsing.

Creation/editing supports title, description and configured status. The CLI preserves
other task fields and structured sections. To avoid hidden Git/network/hook effects,
editing requires these project settings:

```yaml
auto_commit: false
remote_operations: false
check_active_branches: false
```

Projects with `onStatusChange`, and individual tasks with a status hook, must be edited
with the CLI directly. Orca does not change project configuration to bypass this gate.
After an interrupted/failed save, refresh before retrying: the CLI may already have
written the task. Saves are never retried automatically.

## Start work

**Start workspace** opens Orca's existing workspace/agent composer. Confirm the project,
agent and setup policy there. The selected task ID and bounded, explicitly untrusted
source context become the agent's startup draft through the existing launch mechanism.
Starting a workspace does not change the task status. The source project and execution
host must remain selected; switching either is refused rather than reading the task
from a different checkout. No synthetic GitHub issue number or hosted issue URL is used.

## Boundaries and compatibility

Filesystem reads and CLI writes run on the selected execution host. SSH hosts are served by
the Orca server running on that host, so their projects appear as that server's runtime and
carry its `tasks.backlog.v1` capability. Paired runtimes without that capability, older
servers, and an SSH project that is not served by a runtime never receive Backlog calls and
never fall back to local files; reconnect the SSH host so its server serves the project.
Native mobile has its own provider allowlist and does not expose this source or its mutation
RPC. Desktop/web renderers are the supported UI surface.

Runtime `backlog.execute` accepts a registered `repoId`, resolves its path from that runtime's
own project store and runs there; a caller-supplied `repoPath` is not used. Runtime transport
authentication and the `workspace` permission are checked before dispatch, and mobile-scoped
devices cannot call this method. Like other workspace RPCs, it operates with the host user's
authority, not a per-project sandbox.

Task/config paths cannot escape the project or use symlinks. Package-manager links are
accepted only when the resolved CLI package stays inside the project. Reads are bounded
to 128 KiB per task, 16 MiB of task content, 10,000 directory entries and 100 rows per page.
The adapter refuses oversized or duplicate-ID data instead of silently returning an
incomplete board. These checks are not a sandbox for an untrusted project dependency:
the installed Backlog CLI executes with the host user's permissions.

## Contract evidence and tests

The command and storage contract was checked against Backlog.md `v1.48.0`, commit
`da0784d41ad3807fdc34e5501afe3fa950deff94` in
[MrLesk/Backlog.md](https://github.com/MrLesk/Backlog.md/tree/da0784d41ad3807fdc34e5501afe3fa950deff94):
`CLI-INSTRUCTIONS.md`, `ADVANCED-CONFIG.md`, config discovery, task metadata and
create/edit command definitions. Its license is MIT, Copyright (c) 2025 Backlog.md.
The adapter invokes the installed CLI; it does not vendor Backlog.md implementation.

`src/main/backlog/backlog-service.test.ts` covers filesystem/argument boundaries and has
an opt-in real-CLI integration test. Set `ORCA_BACKLOG_TEST_PACKAGE` to an installed
`backlog.md@1.48.0` package directory; the test copies that package and its native sibling
to a temporary project before running create/edit. It does not modify the original
installation. It also exercises a title-only edit of a legacy multiline description.
Parser regressions cover whitespace-delimited config keys inside YAML literals and
quoted/merged task hooks. Hook detection reads complete YAML metadata and fails closed
on unsupported metadata syntax rather than discarding unknown fields.

Host-routing and renderer tests cover ownership, unserved-SSH and capability refusal, source identity,
browsing, saves and opening the workspace composer. Execution has a 45-second overall
response deadline (including scanning), with a 30-second CLI limit and abort signaling;
the renderer RPC ceiling is 65 seconds. A timeout
is not proof that writes stopped. Any unconfirmed save locks that editor, and closing
it keeps create/edit disabled until an explicit refresh succeeds. Inspect the refreshed
tasks before a new attempt; this is not persistent deduplication across page reloads.
These tests do not replace hidden-renderer UI validation or the full application build.
