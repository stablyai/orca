# Vercel Sandbox Ephemeral VM Notes

## Purpose

This notes file records the current Vercel Sandbox recipe experiment for Orca ephemeral VMs. It is intentionally practical: what we set up, what each script does, what failed, and what should be improved before this feels like a clean product path.

The target workflow is:

1. Build one prepared Vercel Sandbox snapshot that contains the Orca repo, Linux dependencies, the Orca dev CLI/server build, `gh`, `codex`, and durable agent auth.
2. Store the snapshot id in repo-local state.
3. Let `orca.yaml` expose a `vercel-sandbox` VM recipe.
4. For each new workspace, create a fresh sandbox from that snapshot, start `orca serve`, return recipe JSON, create one remote worktree, and clean up the sandbox when the workspace is removed.

## Snapshot Model

Vercel Sandboxes are ephemeral running sandboxes, but they can be snapshotted. The intended model here is not to keep one long-lived sandbox running. Instead:

- `orca-base` is a temporary setup sandbox.
- The base setup script installs dependencies and builds enough Orca to run `orca serve`.
- The setup sandbox is snapshotted and stopped.
- Later workspace sandboxes are created from that snapshot.
- Workspace sandboxes are per-worktree resources and should be removed by the recipe cleanup script.

The current state file lives at:

```text
scripts/orca-vm/vercel-sandbox-state.json
```

It records fields such as `snapshotId`, `repoRef`, `repoUrl`, `projectRoot`, Vercel `scope`, and Vercel `project`.

## Scripts

`scripts/orca-vm/vercel-sandbox-base-snapshot.sh`

Creates a temporary base sandbox, installs system packages, installs `gh` and `codex`, clones the configured Orca branch, runs setup, builds the CLI and main-process Electron bundle needed for `orca serve`, snapshots the sandbox, stops it, and writes the resulting `snapshotId` to state.

Important inputs:

- `GH_TOKEN` or `GITHUB_TOKEN`: used for private GitHub clone/auth inside the sandbox.
- `VERCEL_SANDBOX_REPO_REF`: branch to clone, currently `Jinwoo-H/vm-improve-2`.
- `VERCEL_SANDBOX_BASE_TIMEOUT`: must be at most `30m` or `45m` on Hobby, depending on the Vercel limit exposed by the CLI/API.
- `VERCEL_SANDBOX_SCOPE` and `VERCEL_SANDBOX_PROJECT`: select the Vercel team/project.

`scripts/orca-vm/vercel-sandbox-base-auth.sh`

Creates a temporary auth sandbox from the current base snapshot, runs `codex login --device-auth` interactively, verifies Codex login status, snapshots the authenticated sandbox, stops/removes the auth sandbox, and updates `snapshotId` in state.

This is the OAuth path. It avoids exporting an OpenAI API key into the sandbox. The resulting snapshot contains the Codex file-backed auth material, so new sandboxes created from that snapshot should already be signed in.

`scripts/orca-vm/vercel-sandbox-start.sh`

This is the actual `orca.yaml` recipe command. It creates a fresh sandbox from the saved snapshot, discovers the published Vercel URL, updates the repo to the configured branch/commit, builds if needed, starts:

```bash
pnpm exec orca-dev serve --port "$ORCA_PORT" --project-root "$ORCA_PROJECT_ROOT" --pairing-address "$ORCA_PAIRING_ADDRESS" --recipe-json
```

It prints only the final recipe JSON on stdout. Logs go to stderr.

`scripts/orca-vm/vercel-sandbox-cleanup.sh`

Reads the recipe cleanup payload from stdin, extracts `recipeResult.userData.resourceId`, and runs:

```bash
vercel sandbox remove "$resource_id"
```

## `orca.yaml`

The repo-local recipe entry is:

```yaml
environmentRecipes:
  - id: vercel-sandbox
    name: Vercel Sandbox
    command: ./scripts/orca-vm/vercel-sandbox-start.sh
    cleanup: ./scripts/orca-vm/vercel-sandbox-cleanup.sh
```

The command runs locally from the repo root. It owns provider-specific provisioning and must print the recipe contract JSON:

```json
{
  "schemaVersion": 1,
  "pairingCode": "orca pairing code or URL",
  "projectRoot": "/vercel/sandbox/orca",
  "userData": {
    "provider": "vercel-sandbox",
    "resourceId": "sandbox-name"
  }
}
```

## Setup Runbook

1. Authenticate Vercel locally.

```bash
vercel login
vercel sandbox list --scope <scope> --project <project>
```

2. Ensure local GitHub CLI auth can produce a token.

```bash
gh auth status
gh auth token
```

3. Create the base snapshot.

```bash
GH_TOKEN="$(gh auth token)" ./scripts/orca-vm/vercel-sandbox-base-snapshot.sh
```

4. Add Codex OAuth auth to the snapshot.

```bash
./scripts/orca-vm/vercel-sandbox-base-auth.sh
```

Follow the device-auth browser/code prompt. When the script finishes, the state file should contain `codexAuthenticated: true` and a newer `snapshotId`.

5. Verify no setup sandboxes are still running.

```bash
vercel sandbox list --scope <scope> --project <project>
```

Remove stale ones explicitly:

```bash
vercel sandbox remove <sandbox-name> --scope <scope> --project <project>
```

6. Create a workspace in Orca and choose the `Vercel Sandbox` recipe.

## Operational Notes

- `vercel sandbox exec --interactive --tty <name> -- bash` opens an interactive shell inside a running sandbox. Exit with `exit` or `Ctrl-D`; that only exits the shell, not the sandbox.
- To stop billing/compute for a sandbox, remove it with `vercel sandbox remove <name> ...` or snapshot it with `--stop` where appropriate.
- On Hobby, Vercel rejected a `1d` timeout with: `timeout restricted to <= 45m on Hobby plans`. Keep recipe-created sandboxes at `30m` while testing.
- A sandbox created from a snapshot is already running. `exec` only opens a command/session inside it.
- The recipe cleanup path matters because Hobby compute is limited.

## Bugs Found

Project grouping used a stale checkout name.

The local `/Users/jinwoohong/stably/orca` repo had `gitRemoteIdentity: github.com/stablyai/orca` but no `upstream`. Project projection only used `upstream` and GitHub icon metadata, so `/Users/jinwoohong/stably/orca` stayed under a legacy `repo:<uuid>` project while an older worktree named `re-enable-webgl-for-remote-runtime-terminals` became the portable `github:stablyai/orca` project. VM workspaces correctly attached to `github:stablyai/orca`, but the sidebar inherited the stale project display name.

Fix: project projection now uses `gitRemoteIdentity` as another GitHub provider identity source.

Codex hooks failed with broken pipe.

Inside the Vercel sandbox, Codex was launched with `ORCA_PANE_KEY`, `ORCA_TAB_ID`, and `ORCA_WORKTREE_ID`, and hook files existed at `~/.orca/agent-hooks/codex-hook.sh`. However, the Codex process did not have `ORCA_AGENT_HOOK_PORT` or `ORCA_AGENT_HOOK_TOKEN`. The hook script had no valid receiver coordinates, so hook callbacks could not report status to Orca.

Fix: headless `orca serve` now starts the agent hook server, and runtime-created PTYs receive fresh hook receiver env via the runtime terminal launch path.

Other fixes made during the investigation:

- Fresh VM project setup must register the repo before `setupExistingFolder`.
- Slash branches such as `Jinwoo-H/vm-improve-2` must fetch from `origin`, not a nonexistent remote named `Jinwoo-H`.
- VM recipe project ids must be portable provider ids such as `github:stablyai/orca`, not local `repo:<uuid>` ids.
- Runtime setup host ids from the VM must be normalized to `runtime:<environmentId>`.
- Local-only source branches such as `Jinwoo-H/setup-vercel-sandbox` must not be carried into VM worktree creation.
- Successful VM workspace creation must not immediately clean up its runtime.

## Improvements To Make

- Avoid rebuilding in `vercel-sandbox-start.sh` when the snapshot already contains the requested commit.
- Make the recipe doctor validate Vercel CLI auth, snapshot id, project/scope, cleanup behavior, published URL, pairing reachability, `gh` auth, and Codex login.
- Surface Vercel Hobby timeout/compute constraints in setup docs or recipe diagnostics.
- Redact tokens aggressively in logs and never write `GH_TOKEN`, OpenAI tokens, pairing secrets, or Codex auth material into recipe `userData`.
- Consider publishing a Linux Orca artifact for real users. The current dev snapshot builds the main-process bundle from the feature branch only because this VM work is not released yet.
