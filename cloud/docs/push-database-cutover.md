# Dedicated push database operations

Push attaches only to its dedicated PostgreSQL 17 instance: regional HA, 2 vCPU,
7.5 GiB RAM, 50 GiB SSD with automatic growth, seven retained backups and seven-day
point-in-time recovery. Cloud SQL and Terraform deletion protections remain enabled.
The Cloud SQL connector uses the dedicated URL secret pinned to its managed version.
There is no shared-storage fallback or provision/activate switch.

## Existing-resource cleanup: operator prerequisite

This is a plan/runbook, not authorization to apply or delete resources. Preserve the
shared Orca instance, dedicated push instance, all dedicated data and identities, and
unrelated resources. The dedicated resource addresses remain unchanged:

- `google_sql_database_instance.push_dedicated[0]`
- `google_sql_database.push_dedicated[0]`
- `random_password.push_dedicated_database[0]`
- `google_sql_user.push_dedicated[0]`
- `google_secret_manager_secret.push_dedicated_database_url[0]`
- `google_secret_manager_secret_version.push_dedicated_database_url[0]`
- `google_secret_manager_secret_iam_member.push_dedicated_database_url_accessor[0]`

The relay state may still own these six obsolete shared-store resources, whose
configuration is removed. An untargeted plan would propose deleting them; do not apply it:

- `google_sql_database.push[0]`
- `google_sql_user.push[0]`
- `random_password.push_database[0]`
- `google_secret_manager_secret.push_database_url[0]`
- `google_secret_manager_secret_version.push_database_url[0]`
- `google_secret_manager_secret_iam_member.push_database_url_runtime_accessor[0]`

1. Use the production backend in `infra/terraform/README.md`. Inspect state addresses and
   the live service attachment, pinned secret reference and revision resources without
   printing credentials. Require the dedicated attachment and no old shared-store consumers;
   source connection drain needs an authorized operator's read-only observation.
2. Have the shared database owner adopt the six legacy resources in an explicitly owned
   archival configuration before retiring their relay-state ownership. Retain the former
   database's `prevent_destroy` protection and secret versions; do not disable protection,
   drop databases, rotate passwords or introduce a second runtime attachment. A reviewed
   exact-address state transfer must preserve remote IDs and secret material in approved
   Terraform storage, with no credential exports to local files or terminal output.
3. Require the owner's import/ownership plan to preserve existing resources and then an
   empty plan for those addresses. Only after adoption is proven may the operator remove
   precisely the six former addresses from relay state under backend locking. Do not
   automate this via `removed` blocks, broad `state rm`, force, or an untargeted apply.
4. Review a fresh relay plan. Reject every delete or replace affecting either SQL instance,
   dedicated databases/users/secrets, or unrelated resources. Target only the intended push
   service and lease IAM grant for rollout; review their dependency closure too. Existing
   unrelated drift must be handled by its owner, outside this cleanup.

No data transfer, dedicated database reset, or phone re-registration is part of this cleanup.

## Schema prerequisite for existing internal test databases

New schemas omit `push_hosts` and the unused `host_public_key` and `transcript` columns
on `push_challenges`. Authentication still verifies the encrypted transcript and consumes
its challenge digest once; sessions and device ownership are unchanged. No compatibility
migration for unpublished builds runs at application startup.

Before deploying onto an older internal schema, an operator must arrange a separately
reviewed schema-preparation job through the approved database execution path. Its entire
scope is dropping `push_hosts` (including its index) and those two unused challenge columns;
preserve challenge digest/expiry/consumption fields and every session, device and delivery
table. Verify that the old NOT NULL columns are absent before admitting the new image.
Do not hand-edit production SQL or reset the dedicated database to satisfy this prerequisite.
Until that job is reviewed and executed, the new image is not ready for an existing schema.

## Deployment serialization transition

Finish all old push workflow runs before changing the workflow's lock namespace. An old
shared-lock push run and a new push-lock run do not exclude each other. Hold off new push
dispatches while preparing the following exact changes:

1. Review the relay-root plan for
   `google_storage_bucket_iam_member.github_push_rollout_lease[0]`. It grants only
   `roles/storage.objectAdmin` on
   `projects/_/buckets/onorca-cloud-terraform-state/objects/terraform/state/push-rollout/production.lock`
   to the dedicated push deploy account. The lease action uses object GET/upload/delete,
   so no bucket-wide listing or Terraform-state access is needed.
2. After approval, apply only the reviewed IAM/dependency plan. Verify the exact condition
   and principal independently. If foundation still grants push membership in the old
   `cloud_sql_rollout_lease_members`, its owner removes only that push member; keep Relay's
   existing members and permissions. Do not mutate foundation through the relay root.
3. Publish the reviewed workflow on main with `production-push-rollout`, cancellation
   disabled, and the existing lease action pointed at the dedicated object. The durable
   lease covers admission, candidate validation, activation, traffic changes and recovery.
   A stale/conflicting lease stops the run; it is never stolen or force-deleted.
4. Deploy the reviewed image through `cloud-push-deploy.yml`. Preserve candidate readiness,
   runtime-provider validation, exact digest/configuration checks, and explicit activation.
   Verify the public origin and real notification delivery/dismissal afterward.

## Recovery and capacity

Activation starts schema writes and workers before HTTP promotion. Traffic rollback cannot
undo queue or schema changes. Cloud Run cannot delete its latest revision, so failed
activation creates a known-good successor, verifies it, promotes it, then retires rejected
and previous revisions. When partial activation leaves three resources, retire non-latest
inert validation before creating recovery. Failed retirement stops automation. Admission
requires one serving revision resource; retire historical leftovers under the push lease.
Keep the dedicated attachment for application rollback and retain an immutable compatible
image. An image requiring the removed challenge columns needs separate schema review.

The two-instance ceiling and two-connection pool draw four configured connections, twelve
across three simultaneous revision resources. Terraform caps instances × pool × 3 at 64
for serving, validation/rejected and active/recovery pools. Push does not draw from Relay's
shared connection budget. Source connections must have drained before treating that old
allocation as free. Increase capacity only after measuring deployed contention.

Cloud SQL resizing can interrupt connections despite HA. Durable accepted events remain in
SQL; workers retry within each event's original five-minute deadline. Schedule resizes and
verify reconnection, queue recovery, readiness and real delivery afterward.
