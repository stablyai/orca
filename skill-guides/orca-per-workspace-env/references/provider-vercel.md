# Worked example: Vercel Sandbox

Use the executable example in
[`examples/environments/vercel-sandbox`](https://github.com/stablyai/orca/tree/main/examples/environments/vercel-sandbox).
It supplies the base builder, desktop launchers, ownership journal, and all four
lifecycle commands. Copy it into the consuming project's primary checkout under
`scripts/orca-vercel-sandbox/` and merge its `environmentRecipes` into `orca.yaml`.
Recipes present only in a linked worktree are not discovered.

The example pins `@vercel/sandbox@3.3.0`, `sandbox@4.4.0` and `@vercel/oidc@3.2.0`.
Run its documented `npm ci` setup. The standalone CLI command is `sandbox`, not
the placeholder `vercel sandbox` flags in older versions of this guide. Use the
SDK for structured metadata; do not extract snapshot IDs or routes from human
CLI output.

## Connection and recovery

This uses Orca-server mode. Create starts a headless server, obtains its public
HTTPS route from `sandbox.domain(6768)`, supplies the corresponding `wss:` address
to `orca serve --pairing-address`, and forwards `--recipe-json` with ownership
metadata in `userData`. The server is a detached SDK command. Its output goes to
a protected remote file; the recipe polls readiness and then exits.

Orca's runtime installation, user project and persisted Orca profile live in
separate directories. The source-build launcher is
`node config/scripts/orca-dev.mjs serve …` from the runtime checkout. Its profile
override is `ORCA_DEV_USER_DATA_PATH`. Keep explicit remote working directories:
a custom snapshot may lack the SDK's default `/vercel/sandbox`, including when
uploading files to absolute paths.

Persistent sandboxes save files when stopped. Resume retrieves the exact existing
sandbox and requires a usable recovery snapshot, then restarts the headless server
with its saved profile. It never resets or reclones the project. Do not use
`getOrCreate` for workspace recovery: it can recreate a sandbox when its saved
state has expired. Filesystem recovery is separate from process continuation and
agent-session recovery; test all three. Use the workspace Sleep action and wake
its sidebar row. After a desktop restart while suspended, use Settings → Remote
Orca Servers → Cloud VM → Resume. The desktop must include this change; Running
hosts offer Reconnect to retry project discovery.

## Authentication and snapshots

The README documents project-scoped OIDC through the existing Vercel login and
explicit token/team/project credentials. Control-plane credentials remain on the
desktop. Sandbox CLI login is separate from the Vercel credential store used by
the OIDC helper; run `node auth.mjs` before provisioning. Coding-agent authentication
is separate. An AI Gateway key can be injected
on each server start, or the user can log the agent in inside the workspace.

Take the reusable base before starting any Orca server or creating its identity.
Test disposable children. Recovery snapshots preserve the workspace's profile,
paired devices and agent files, so treat them as private. A credentials-bearing
auth snapshot must never be published or used as a shared public base.

## Cleanup and verification

The recipe records intent before creating a sandbox, verifies its ownership tag,
and tracks exact session and snapshot IDs. Cancellation can kill the recipe
before a trap runs; use `node lifecycle.mjs reconcile JOURNAL_ID` to retry cleanup.
Never remove a resource on name prefix alone. Deleting a sandbox does not, by
default, delete its snapshots. Shared bases and explicitly retained artifacts need
separate retention accounting.

Run `orca vm recipe doctor vercel-sandbox --repo-path /absolute/project --json` and
require all checks to pass without warnings. Then use `--provision` for the real
create/destroy boundary. Finally exercise the rendered Cloud VM workflow: agent
edits, client reconnect, host sleep/wake, desktop restart while suspended, change
download, and teardown. A successful
base build or standalone provisioning command does not establish that workflow.

Consult the current [SDK reference](https://vercel.com/docs/sandbox/sdk-reference),
[CLI reference](https://vercel.com/docs/sandbox/cli-reference), and
[persistence contract](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)
before upgrading the pins.
