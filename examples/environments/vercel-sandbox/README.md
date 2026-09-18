# Vercel Sandbox environment for Orca

This example connects Orca to a headless Orca server in Vercel Sandbox. It uses
Orca's existing Cloud VM recipe interface. Workspace files and the Orca profile
are saved when the host stops. Starting a new VM session restarts the server;
an interrupted coding-agent process must be restarted separately.

## Requirements

- A desktop build containing this change, Node.js 24 or newer, npm, and Git.
  The Settings Resume/Reconnect controls are added here; the remote base remains
  pinned to Orca 1.4.197. Build the desktop using the repository contribution guide.
- A Vercel project with Sandbox access. The desktop must reach Vercel's API and
  published HTTPS/WebSocket routes. The sandbox needs outbound package-registry,
  repository and coding-model access. This example leaves outbound networking open.
- A public HTTPS Git repository and its full 40-character commit SHA. Private
  repository credential forwarding is outside this example.
- SDK `@vercel/sandbox@3.3.0`, CLI `sandbox@4.4.0`, and OIDC helper
  `@vercel/oidc@3.2.0`, locked in this directory. The base builds Orca commit
  `6252f8149bc5b72985e830ff830a178f61997b8b` using pnpm `12.0.0`, with Codex
  `0.154.0`. The managed Node 24 image can change; retain the generated base
  snapshot for repeatable workspace creation.

## Install in the project's primary checkout

Copy this directory to `scripts/orca-vercel-sandbox/` in the project you want to
work on. Merge the included `environmentRecipes` entry into that project's
`orca.yaml`. Orca discovers recipes from the project's primary checkout. Placing
these files only in a linked Git worktree does not add the recipe to its catalog.

```bash
cd scripts/orca-vercel-sandbox
npm ci --ignore-scripts
chmod +x run.sh
```

If your npm installation enforces a minimum release age and rejects these pins,
wait for the configured delay or explicitly approve an exception for this locked
install. Do not change the SDK version implicitly.

On Windows, replace each `./scripts/orca-vercel-sandbox/run.sh` in `orca.yaml`
with `.\scripts\orca-vercel-sandbox\run.cmd`. Remote commands run on Linux;
the desktop launchers use Node on macOS, Linux and Windows.

Create a private config file **outside the repository**:

```json
{
  "team": "your-team-slug",
  "project": "your-project-slug",
  "stateDirectory": "/absolute/private/path/orca-vercel-journals",
  "region": "iad1",
  "repoUrl": "https://your-git-host/owner/project.git",
  "repoRef": "FULL_40_CHARACTER_COMMIT_SHA"
}
```

Set `ORCA_VERCEL_CONFIG` to its absolute path in the environment inherited by
Orca and by your setup terminal. On Windows, use a JSON-escaped absolute Windows
path for `stateDirectory`. Keep this journal directory: it is needed for lifecycle
operations and for recovering cleanup after an interrupted command.

Authenticate the SDK with either an existing Vercel CLI login and the team/project
slugs above, or an access token in `VERCEL_TOKEN` and exact `team_…` and `prj_…`
IDs in the config. The pinned OIDC helper reads the Vercel CLI credential store;
Sandbox CLI login is separate. Run the SDK check before building:

```bash
node auth.mjs
```

All three SDK credential fields are supplied together. Control-plane credentials
stay on the desktop. If you also want to inspect resources with the standalone
CLI, authenticate it separately with `npx --no-install sandbox login`.

## Build the base

```bash
node bootstrap.mjs
```

This creates one 4-vCPU build host with a 40-minute deadline, installs Linux
libraries and the pinned tools, then builds Orca's CLI and headless runtime.
Copy the printed `snapshotId` into your private config. The build host is deleted;
the base snapshot is deliberately retained with a seven-day TTL. Use extends its
expiry. No Orca server is launched before this reusable snapshot is taken.

The script prints its journal ID before provisioning. If a build fails, inspect
`/vercel/orca-control/build.log` using the Sandbox dashboard or CLI. While that
exact host remains running, `node bootstrap.mjs JOURNAL_ID` continues the recorded
build. To discard it, run `node lifecycle.mjs reconcile JOURNAL_ID`.

For Codex through Vercel AI Gateway, make `AI_GATEWAY_API_KEY` available to the
Orca desktop. The recipe injects it into each server start and configures Codex
for `openai/gpt-5.6-terra` in the remote user’s `~/.codex/config.toml`,
which Orca mirrors into its managed Codex home. Select Codex explicitly; Orca’s
default agent may be different. The key is not written to config or the base snapshot.
Alternatively, use your agent's own login flow in the remote workspace. Agent
credentials written inside a workspace become part of its private recovery
snapshots. Verify authentication with an actual agent task.

## Create and work

1. Enable **Settings → Experimental → Cloud VM**.
2. Open **New workspace → Run on → Per-Workspace Environment → Vercel Sandbox**.
3. Name the workspace, create it, and approve the recipe's hook prompt.
4. Orca provisions the host and connects using the server's pairing result. Open
   **New tab → New Terminal** and make a change with your chosen agent.

For the configured Codex/Gateway path, the verified invocation is:

```bash
codex exec --sandbox danger-full-access 'Make the requested change and run its tests.'
```

Run this inside the Vercel workspace. In the tested VM, Codex's nested
`workspace-write` sandbox failed at its `bwrap` capability check. This invocation
uses the Vercel VM as the execution boundary; the agent can access files and
injected credentials throughout that VM.

For a free configuration check, run this from a terminal with Orca on PATH:

```bash
orca vm recipe doctor vercel-sandbox --repo-path /absolute/project --json
```

Require every check to be `pass`. `--provision` additionally creates and destroys
an environment; it does not verify an agent task or the rendered workspace flow.

Runtime installation is `/vercel/orca-runtime`, the project is `/vercel/project`,
and the persisted Orca profile is `/vercel/orca-profile`. Create fetches the pinned
project once. Resume never fetches, resets or replaces the user's repository.
Port 6768 is published over HTTPS, and the server advertises its corresponding
`wss:` address. Treat pairing results as credentials; do not paste them into logs.

## Disconnect, sleep and recover

Use the workspace's **Sleep** action to suspend it and activate its sidebar row to
wake it. After restarting the desktop while it is suspended, use **Settings →
Remote Orca Servers → Cloud VM → Resume**. A running host offers **Reconnect** to
retry connection and project discovery. Lifecycle operations include provider and
local connection work; failed recovery remains visible for retry.

Client disconnect leaves the VM running until its configured timeout (30 minutes
by default). Host sleep stops the current session and waits for a usable filesystem
snapshot. Recovery keeps the same sandbox name and restores its saved filesystem,
then starts Orca with the preserved profile and a fresh advertised route.

Filesystem persistence does not preserve live processes. Check files, Git state,
Orca reconnection and agent-session history independently. Start a new agent turn
or use the agent's supported session-resume command after recovery.

The recipe refuses a missing sandbox, unavailable recovery snapshot, mismatched
ownership marker or missing repository. It does not silently create a replacement
from the base. Retrieve valuable changes before the snapshot expires. Workspace
snapshots have a one-day TTL and retain the latest two copies.

## Retrieve changes

Review your changes in Orca's source-control pane. To export a patch, use the
remote terminal in your workspace; stage only files you want to include:

```bash
git add -- README path/to/new-file
git diff --cached --binary HEAD > orca-changes.patch
```

In Orca's file explorer, download `orca-changes.patch` to your desktop. In a clean
local checkout at the same base commit, review the patch, run `git apply --check
orca-changes.patch`, then `git apply orca-changes.patch` and your project tests.
Staging new files before producing the patch includes them in the export.

## Destroy and interrupted cleanup

Use **Settings → Remote Orca Servers → Cloud VM → Cleanup** to destroy the environment. Destruction
removes the exact owned host and its workspace snapshots. It preserves the shared
base and any deliberately retained snapshot listed in the journal.

If provisioning is canceled or cleanup fails, use the printed journal ID:

```bash
node lifecycle.mjs reconcile JOURNAL_ID
```

This command checks the recorded project, resource name and ownership tag, records
all sessions and owned snapshots before deleting the host, then deletes only those
snapshots. Vercel may retain deleted snapshot records in inventory; those records
are accepted only with provider status `deleted`. Provider errors remain failures so cleanup can be retried. Do not infer
successful cleanup from a client timeout or an empty first page of inventory.

An interrupted local process can leave `JOURNAL_ID.json.lock`. Inspect its PID and
confirm that this particular recipe process has exited before removing the lock;
never remove the lock of a live process. Retry reconciliation afterward. Retain
the journal until provider inventory confirms cleanup. Never delete resources by
name prefix alone. Explicitly manage the base snapshot's retention separately.

## Verification

```bash
node --test
```

The unit suite covers protocol validation, source inputs, ownership fences,
ambiguous responses, cleanup retries and recovery refusal. Live Orca UI, coding,
reconnect, host recovery and export checks are separate integration gates; unit
tests alone do not establish that those boundaries work.

The live validation used macOS Orca and Linux Vercel VMs. It verified agent edits,
client reconnection, Sleep/wake, desktop restart followed by Settings Resume,
a new agent turn after recovery, patch download/application, automatic timeout,
and cleanup after failed or interrupted provisioning. Client disconnect used Orca's runtime API; reconnection used the rendered Settings
Reconnect control and verified the restored diff. The native download destination chooser
was substituted while the actual file transfer ran. Windows launchers and native
focus behavior have not been exercised. Interrupted agent-turn continuation has
not been verified; the observed recovery starts new processes.

Authoritative references: [Sandbox SDK](https://vercel.com/docs/sandbox/sdk-reference),
[CLI](https://vercel.com/docs/sandbox/cli-reference),
[persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes),
[authentication](https://vercel.com/docs/sandbox/concepts/authentication),
[Codex on AI Gateway](https://vercel.com/docs/ai-gateway/coding-agents/openai-codex).
