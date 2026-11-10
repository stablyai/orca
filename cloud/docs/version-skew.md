## Version skew (desktop vs the orcad in a sandbox)

Runbook section for `.context/cloud/launch-runbook.md` (kept here so it is reviewed with the code).

**How the golden tracks integration.** With `GOLDEN_IMAGE_SOURCE=git:https://github.com/nwparker/orca-private#cloud/integration`
(dev today), the per-minute cron (`advanceGoldenImages`, one state machine per region) rebuilds orcad + CLI from
cloud/integration HEAD whenever HEAD changes VM paths (`golden-source.ts` `VM_PATHS`: `src/main|shared|cli|relay|orcad`,
`packages/`, `mobile/`, the image dir, the lockfile). Build, smoke (orcad ready), then an atomic swap: the new row
becomes `active`, the previous one `retired` (still bootable), and older retired rows are deleted. The commit is the
row's `bundle_sha256` (`git:<sha>`) and `/opt/orca/runtime/orcad/SOURCE_COMMIT` in the VM. Only **new** sandboxes boot
the new image. Sleep, wake, Restart and the 24 h restart all boot the sandbox's own disk, so a workspace keeps the
orcad it was created with (VM entry-point scripts are synced on boot; orcad is not, and there is no orcad self-update
in the VM). A desktop release can therefore be older or newer than any sandbox.

**Which build a sandbox runs.** `orca status --json` against the workspace's environment shows `runtime.appVersion`,
`runtime.buildCommit` (from SOURCE_COMMIT, else the bundle's package stamp) and `runtime.runtimeProtocolVersion` /
`runtime.minCompatibleRuntimeClientVersion` (all from `status.get`). In the VM: `cat /opt/orca/runtime/orcad/SOURCE_COMMIT`.
Golden per region: `SELECT id, region, status, bundle_sha256, snapshot_id, expires_at, activated_at FROM golden_images
WHERE status IN ('active','retired')`.

**Policy.** Compatibility is the runtime protocol range in `src/shared/protocol-version.ts`, never commits or app
versions. The desktop speaks `RUNTIME_PROTOCOL_VERSION` and accepts sandboxes at or above
`MIN_COMPATIBLE_RUNTIME_SERVER_VERSION`; orcad publishes its protocol and the minimum client it accepts
(`MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION`). Inside the range: proceed silently (normal skew). Outside it: the desktop's
existing RPC gate refuses calls (that is the unsafe case) and the workspace shows a notice. Rules for changes:
- Additive RPC changes (new methods, optional fields, ignorable events) bump nothing.
- Bump `RUNTIME_PROTOCOL_VERSION` only for removed methods, new required params or changed meaning.
- Never raise `MIN_COMPATIBLE_RUNTIME_SERVER_VERSION` above the protocol of live sandboxes (they cannot upgrade in
  place) unless we accept that those workspaces must be recreated.
- Raising `MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION` strands every desktop below it until its user updates.

**What users see** (only outside the range): a quiet, dismissible card at the top right of the cloud workspace, never
a cover.
- Desktop too old: "This cloud workspace uses a newer version of Orca" / "Update Orca on this computer to connect to
  it. Your files are safe." Button: "Check for updates".
- Sandbox too old: "This cloud workspace uses an older version of Orca" / "This version of Orca can't connect to it,
  and restarting won't update it. Your files are safe. New cloud workspaces use the current version." Button:
  "Create workspace" (composer preset to Orca Cloud and the same repository).
- Builds and protocol numbers go to the renderer console (`[orca-cloud] version skew`), never the card.

**Roll a golden back** (a bad build reached `active` in a region). D1 `orca-sandbox-control-<env>`, via
`wrangler d1 execute <db> --remote --command "<sql>"`:
1. Stop the cron rebuilding the same HEAD: mark the bad row failed. The cron skips a failed sha for 6 h.
   `UPDATE golden_images SET status='failed', error='rolled back', updated_at=<now ms> WHERE id='<bad id>'`.
   For longer than 6 h, revert the bad commit on cloud/integration (HEAD moves, the next build replaces it) or unset
   `GOLDEN_IMAGE_SOURCE` and redeploy with `python3 ~/.orca-cloud-ops/deploy-control.py "<note>"`.
2. Reactivate the retired image: `UPDATE golden_images SET status='active', activated_at=<now ms>, updated_at=<now ms>
   WHERE id='<retired id>' AND region='<region>'`. Check its `expires_at` is in the future first; an expired snapshot
   cannot boot (fall back to the seed `GOLDEN_SNAPSHOT_ID` or a fresh build).
3. Verify: create a workspace in that region, orcad becomes ready, and `orca status --json` shows the old `buildCommit`.
   Warm pool VMs from the bad image are replaced on the next refill (the pool keys VMs by image).
4. Sandboxes created on the bad image keep it (no in-place downgrade); recreate them if the bug affects them.
   Environment builds made on the bad golden are stale against the restored one (`base_snapshot_id` differs), so
   `refreshStaleEnvironments` rebuilds them in the background; their workspaces, like any sandbox, keep their disk.
