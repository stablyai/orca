# Custom agents: forward-rollback runbook

Operational contract for rolling back a release that ships the agent-catalog **v1**
schema (`agentCatalogSchemaVersion: 1`). Grounded in plan §1021-1028 (Rollout and
rollback contract) and acceptance oracle 39.

## Why a plain downgrade is unsafe

The v1 data file is **forward-readable but not honestly writable** by an older Orca
binary: pre-v1 code does not understand custom identities in defaults, owner
records, or resume attribution. Runtime compatibility projections protect old
_clients_; they do not make a downgraded desktop binary schema-aware.

## Rules

1. **Production rollback = a forward-rollback build.** It keeps the v1
   reader/resolver and may disable new authoring. It must never disable identity
   resolution for already-saved defaults, automations, or sessions.
2. **Never install a pre-v1 binary over a live v1 data file.** Release automation
   must not resolve a feature incident this way.
3. **Explicit user downgrade = restore the pinned backup** (below). This is the
   only supported pre-v1 binary rollback and discards settings/workspace metadata
   written after the backup point. Users perform this through **Data recovery**;
   direct file manipulation is a support-only fallback.
4. **Offline CLI writes are schema-transparent.** CLI commands that edit the
   data file while the app is not running (e.g. `orca agent hooks on|off`) must
   never add, upgrade, or default any agent-catalog schema field, and must
   refuse the write when the file carries a newer schema than the binary knows.
   Only the app's migration path may perform the first v1 write.
5. **The hard protocol-floor bump ships only after the rollback window closes.**
   While a forward-rollback build is a supported production state, raising
   `MIN_COMPATIBLE_DESKTOP_VERSION` (or retiring the
   `agent-launch.identity.v1` soft capability phase) would strand updated
   clients against a rolled-back host.

## The pinned pre-v1 backup

- Written once, before the first v1 write, beside the rotating backups at
  `<data-file>.pre-agent-catalog-v1.backup` (`pinnedPreV1BackupPath`).
- Same filesystem permissions as the data file; `fsync` + atomic rename.
- If it cannot be created, migration performs **no v1 write**; launch behavior
  stays on the clean built-in baseline and catalog/reference writes remain
  blocked until migration succeeds.
- Never synced, never given weaker permissions, and never exposed to the renderer
  as raw contents or a filesystem path. The renderer receives only recovery-point
  metadata and invokes main-process-owned retry/restore operations.
- Removed only after the documented one-release rollback window (see follow-up).

## Migration user experience

The v1 migration runs during profile load; users do not need to open Settings to
start it or learn that it failed. A successful migration is silent. A failed
backup or migration produces a persistent, app-level notice
(`DataRecoveryMigrationNotice`) as soon as the profile is loaded. The notice
explains that:

- Orca left the existing data unchanged;
- built-in agent launches remain available; and
- custom-agent catalog and reference changes are read-only until recovery.

The notice provides **Retry migration** and **Open Data recovery** actions plus
copyable local error details. It remains visible across navigation and relaunches
until retry succeeds or the user restores a recovery point. Settings mirrors the
same status and actions, but is not the only place that reports the failure.

## General Data recovery UI

Backup restoration is a reusable main-process capability
(`src/main/data-recovery/recovery-points.ts`), not an agent-catalog-specific
file-copy instruction. **Data recovery** inventories recovery points for this
and future migrations (new migrations register their points there). Each entry
shows its migration identifier, creation time, compatibility target, and a
plain-language summary of data that will be lost. The renderer receives
metadata only — never a filesystem path or backup contents.

After explicit confirmation, the main process validates the selected backup,
suspends writes, creates a separate pre-restore safety copy, and atomically
replaces the live data file. Cancellation or failure leaves both the current file
and recovery point intact and reports an actionable local error.

For a recovery point compatible with the running build, the final action is
**Restore and restart**. For the pinned pre-v1 point, it is **Prepare downgrade**:
Orca restores the point and quits without relaunching, preventing the current v1
build from immediately migrating the restored file again.

## Remote hosts (`orca serve`)

Catalogs are per-host. A serve host runs the same profile load, migration, and
pinned backup against its own data file on its own disk; every rule above
applies to each host independently. A desktop and a remote host are rolled back
separately and may skew — runtime projections and the protocol floor cover the
skew, not this runbook.

Serve-host contract:

- The migration-blocked state is projected env-free over runtime RPC as a
  `migrationBlocked` boolean on the remote catalog snapshot — never the local
  error text — so a connected client (mobile, paired web, remote desktop) can
  show that the host's catalog is read-only pending recovery. Mobile surfaces
  it in the agent picker.
- The headless downgrade replaces **Prepare downgrade**: stop the serve process
  and disable any supervisor auto-restart, restore the pinned backup, install
  the pre-v1 binary, then start the service. A supervisor that relaunches the
  v1 binary after the restore re-runs the migration and defeats the downgrade.
- New desktop/paired-web clients follow the same probe-and-degrade contract as
  mobile and the CLI (compat design, client column): probe
  `agent-launch.identity.v1` before sending an identity-only `agentLaunch`
  (`worktree-create-launch-compat.ts`); a pre-identity host gets the legacy
  built-in id fallback, and custom/default selections fail fast with an
  update-the-host error.

## Mobile clients

Mobile needs no rollback procedure of its own: it never writes the catalog,
holds only an in-memory env-free per-host cache, and old clients are protected
by the legacy projections and the capability/protocol floor. Its half of a host
incident is displaying the projected migration-blocked state above.

## Crash safety (oracle 39)

Schema migration, backup creation, catalog/reference mutation, and snapshot
persistence are independently fault-injected. Any crash leaves **either** the
complete old file + usable backup **or** the complete v1 file + usable backup —
never a half-migrated file. The backup is created before any v1 write, so a crash
mid-migration always finds an intact v0 file to restart from.

## Explicit downgrade procedure

1. Open **Data recovery** from the app-level migration notice or Settings.
2. Select the recovery point labeled as the state before agent-catalog v1.
3. Choose **Prepare downgrade**, review the post-backup data-loss summary, and
   confirm. Orca restores the point atomically and quits.
4. Install the pre-v1 binary before opening Orca again, then relaunch.

The restored file is byte-identical to the pre-v1 state; all post-backup metadata
is intentionally discarded.

### Support-only manual fallback

Use this only when Orca cannot open Data recovery:

1. Quit every running Orca process, including terminal daemons and any `orca`
   CLI invocation — a v1-era CLI's offline write between restore and downgrade
   can re-stamp the schema.
2. Preserve the current `<data-file>` separately, then copy
   `<data-file>.pre-agent-catalog-v1.backup` over `<data-file>`.
3. Install the pre-v1 binary before opening Orca again, then relaunch.

Support must verify the profile and paths before copying; the UI flow above is the
normal user procedure.

## Verification

Rollback verification runs on a **disposable** profile, never on user data:
`src/main/agent-launch/agent-catalog-forward-rollback-fixture.test.ts` exercises
migrate → v1-reference resolve → forward-rollback resolve → pinned-backup restore →
crash-before-write restart. Unit field-mapping coverage lives in
`agent-catalog-schema-migration.test.ts`. CLI offline-write schema transparency
(Rule 4) is covered in `src/cli/handlers/agent-hooks.test.ts`; load-time
surfacing of the blocked state in `agent-catalog-service.test.ts` and
`AgentCatalogSection.test.tsx`; retry in
`persistence-agent-catalog-migration.test.ts`; inventory/atomic
restore/safety-copy/failure-unfreeze in
`src/main/data-recovery/recovery-points.test.ts`; the app-level notice, retry
actions, and Prepare-downgrade flow in `DataRecoveryMigrationNotice.test.tsx`;
the client probe-and-degrade in `worktree-create-launch-compat.test.ts`; the
serve `migrationBlocked` projection in `agent-catalog-service.test.ts` and
`mobile-agent-catalog-projection.test.ts`.

Before release, end-to-end coverage should still exercise the full
restore-quit-relaunch cycle against a packaged build (component/unit tests
above stop at the IPC boundary).

## Follow-up (fill before merge)

- Dated removal of the pinned backup and the end of the one-release rollback
  window: **TODO(date)** — owner to set at release cut.
