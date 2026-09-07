# Administer agent skill sharing

This guide describes the first-release access, lifecycle, retention, and recovery contract for
Orca skill sharing. The operator runbook remains the source of truth for incident commands and
environment-specific procedures.

## Access model

- Shared bundles are unlisted bearer resources. Orca provides no public browse, search, recipient
  inventory, or package index.
- Anyone with an active, unexpired link can inspect the package and request a short-lived download
  grant without signing in.
- Publishing, package/version management, owned-link inventory, revocation, and deletion require
  an authenticated package owner with current organization access.
- Missing, expired, revoked, deleted, and unauthorized resources return the same non-disclosing
  response.
- Desktop and remote runtimes receive no GCP identity or long-lived storage credential.

The durable share ID is a credential. Do not put it in tickets, logs, analytics, or support
bundles. Use revocation if a link may have reached an unintended recipient.

## Revocation and deletion

Revoking a share immediately blocks new resolution and download grants. A generation-bound grant
issued before revocation can work until its five-minute expiry. Already installed skills remain on
recipient machines.

Package deletion follows this order:

1. Mark the package deleted and revoke its active shares.
2. Dereference retained versions transactionally.
3. Delete only an object generation that no retained version references.
4. Reconcile bounded pending deletions after partial database or GCS failures.

A version cannot be deleted while an active pinned share references it. Deletion uses the exact
recorded GCS generation and never overwrites an immutable published key.

## User and organization departure

Packages belong to an owner tenant and record the publishing user. In an organization tenant,
another current member can manage the package after its publisher leaves; Orca does not rewrite
the recorded creator. Removing a user does not automatically revoke the organization's links,
delete packages, or remove installed copies.

Before deleting an organization tenant:

1. Disable new grants for the tenant.
2. Have an authorized operator inventory and revoke active shares.
3. Decide whether packages transfer to another authorized owner, remain retained, or are deleted.
4. Resolve legal hold, erasure, and audit-retention requirements.
5. Apply the coordinated metadata and object lifecycle; do not bypass reference checks.

The product does not yet encode a universal ownership-transfer or legal-retention policy. Privacy,
security, and the organization owner must approve the applicable policy before external rollout.
Until that decision is recorded, preserve metadata and soft-deleted generations rather than
guessing.

## Retention contract

| Data                                   | Default behavior                                          |
| -------------------------------------- | --------------------------------------------------------- |
| Upload policy and pending upload row   | Expires after 15 minutes                                  |
| Abandoned `uploads/` quarantine object | Deleted by GCS after one day                              |
| Published immutable package object     | No age-based deletion; retained while referenced          |
| Issued download grant                  | Expires after five minutes                                |
| Deleted package object                 | Recoverable through GCS soft delete for seven days        |
| PostgreSQL metadata                    | Covered by backups and seven-day point-in-time recovery   |
| Installed recipient copy               | Independent local data; Cloud deletion does not remove it |
| Audit event                            | Follows the approved audit-retention policy               |

Organization retention, legal hold, and erasure requirements take precedence over product rollback
retention. Product deletion is not a legal-hold mechanism.

## Audit and privacy

Audit records may include package/version IDs, actor IDs, event category, outcome, and timestamp.
They must not include skill contents, filenames, manifests, organization membership lists, local
paths, durable share URLs, upload policies, download grants, or credentials. Anonymous abuse
controls must not persist raw requester IP addresses.

Normal Cloud logs are limited to route, method, status, duration, and bounded failure categories.
Use seeded privacy canaries when validating staging logs and diagnostic exports.

## Recovery and incident controls

Upload, download, and remote-install operations have independent kill switches. Disable the
narrowest affected operation; existing local discovery and installs continue to work.

Coordinate PostgreSQL point-in-time recovery with GCS generation recovery. Restore metadata into
an isolated database, identify exact referenced generations, restore only matching soft-deleted
objects, verify archive and package identities, then transactionally repoint metadata. Keep grants
disabled until bearer preview and a generation-bound download pass.

See the Orca Cloud `docs/skill-sharing-runbook.md` for deployment controls, reconciliation,
saturation, signing failures, database outages, and the guarded restore workflow. Security
invariants and unresolved release gates are recorded in
[Agent skill sharing threat model](./agent-skill-sharing-threat-model.md).
