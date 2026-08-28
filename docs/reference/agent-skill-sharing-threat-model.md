# Agent skill sharing threat model

Status: implementation baseline for security and privacy review. This document does not constitute
security approval.

## Scope and trust model

This model covers private skill packaging, Orca Cloud publication and authorization, durable share
resolution, local and remote installation, provider placement, update, rollback, removal, and
operator recovery. It applies to macOS, Linux, native Windows, WSL, paired Orca runtimes, and SSH
targets.

Private means unlisted: an unpredictable active share ID is a bearer credential, while publication
and management remain access-controlled to authenticated Orca users and organizations. V1 is not
end-to-end encrypted from Orca Cloud operators. A skill is code from its author: `SKILL.md` can
change agent behavior and packaged scripts may be executed later by a user or agent, although the
installer itself never executes package content.

## Protected assets

- Skill contents, filenames, manifests, package metadata, release notes, and author identity.
- Organization membership, selected-user ACLs, durable share identifiers, and package existence.
- Signed upload policies, download grants, authentication tokens, database credentials, and GCP
  service identities.
- Existing local skills, provider configuration, user modifications, provenance, and transaction
  recovery state.
- Cloud package metadata, immutable object generations, audit records, and deletion state.
- Availability and cost of Cloud Run, Cloud SQL, GCS, connected runtimes, and local filesystems.

## Actors and boundaries

Actors include an authorized publisher, an authorized recipient, an authenticated but unauthorized
Orca user, a malicious skill author, a compromised renderer, an untrusted remote RPC caller, an
attacker controlling a network endpoint, and an operator with GCP or database access.

Trust boundaries are:

1. Source skill directory to the owner-private package staging directory.
2. Desktop renderer to the main process and its authenticated Cloud client.
3. Orca client to a paired runtime or SSH host across independently versioned protocols.
4. Orca Cloud API authorization to short-lived GCS access.
5. GCS quarantine to validated immutable publication and PostgreSQL metadata.
6. Extracted staging to canonical destination and provider placements.
7. Local diagnostic records to a user-reviewed support-bundle upload.
8. Terraform and deployment identities to staging and production resources.

## Security invariants

- Package identity is deterministic and binds normalized paths, exact bytes, executable state, and
  immutable package/version IDs.
- Publication and installation accept only the `manifest.json` plus `skill/` envelope and never
  execute archive content.
- Archive validation completes before destination mutation.
- Destination paths are resolved by the runtime that owns the host or workspace.
- Unowned or modified local content is never silently replaced or deleted.
- Final GCS objects are immutable, generation-fenced, and reachable only through fresh ACL checks
  followed by short-lived grants.
- No remote caller can turn a desktop-local path into remote filesystem authority.
- Interrupted transactions converge to a verified old or requested version.
- Logs and support bundles exclude package contents and private authorization or filesystem data.
- Cloud sharing, downloading, and remote installation have independent kill switches.

## Threat register

| ID    | Threat                                                                                                                                            | Required controls and current evidence                                                                                                                                                                                                                                                                                                        | Residual release gate                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| TM-01 | Source changes after preview or a link swaps bytes during packaging.                                                                              | Observe the specific source directory, copy without following links, re-observe staged bytes, compare every identity, and bind preview to the final digest. Source-drift and link/special-file tests cover rejection and cleanup.                                                                                                             | Repeat race and permission tests on every supported filesystem.                          |
| TM-02 | Archive traversal, drive paths, links, devices, duplicate paths, Unicode/case collisions, or decompression/resource exhaustion escape staging.    | Streaming parser rejects unsafe entry classes and normalized collisions; compressed, extracted, entry, file, depth, and per-file limits are enforced during parsing and extraction. Boundary, malformed, checksum, and fuzz tests run before destination mutation.                                                                            | Keep package safety suites required in release CI.                                       |
| TM-03 | A forged manifest lies about names, bytes, executable state, or package identity.                                                                 | Parse the manifest before trusting entries, require `skill/SKILL.md`, hash extracted bytes independently, recompute package identity, and compare package/version IDs and digest.                                                                                                                                                             | Cross-platform identical-byte digest evidence remains required.                          |
| TM-04 | A client chooses another home, workspace, WSL distro, SSH path, or escapes a destination root.                                                    | The executing runtime resolves home and workspace identities, realpath-checks directories, uses platform-native joins, and rejects client-supplied remote paths. `local-file` ingress is trusted in-process only.                                                                                                                             | Real SSH and mixed-version topology tests remain required.                               |
| TM-05 | Installation overwrites or deletion removes unowned or locally modified content.                                                                  | Planner distinguishes missing, unchanged, clean, modified, unowned, external-link, broken-link, and collision states. Provenance lives outside installed content. Replacement requires an explicit conflict decision; removal revalidates ownership and digest.                                                                               | Complete the remaining real junction, external-link, copy-drift, and permission matrix.  |
| TM-06 | A crash between renames or receipt publication loses both old and new versions.                                                                   | Same-filesystem staging, durable journals, backups, flushed receipt replacement, bounded recovery, and ownership tokens protect every commit boundary. Failure injection covers every journal transition.                                                                                                                                     | Real process termination and disk/antivirus contention tests remain required.            |
| TM-07 | A grant leaks through redirects, userinfo, an insecure scheme, DNS/host confusion, or an oversized stream.                                        | Cloud requests reject redirects. Package downloads require configured origins and HTTPS, reject URL credentials and cross-origin redirects, cap redirect count, recheck expiry, stream exact expected bytes, and verify archive/package digests.                                                                                              | Validate approved production origins and exercise malicious network cases in staging.    |
| TM-08 | Reuse of an upload ID, wrong tenant, wrong key, stale generation, or quarantine object publishes attacker-selected bytes.                         | Random tenant-bound upload rows, signed POST conditions, expiry, exact metadata/key/type/size validation, generation-fenced reads, streamed validation, and idempotent finalization fail closed.                                                                                                                                              | Staging GCS integration must cover stale generations and lifecycle deletion.             |
| TM-09 | IDOR, stale organization membership, or a guessed identifier exposes package management data or bearer-protected content.                         | Management requests authenticate and re-evaluate current ownership. Recipient preview and grants require the exact unpredictable, active bearer share ID and ignore legacy ACL rows. Not-found responses hide unauthorized existence.                                                                                                         | Human authorization review and organization-departure policy approval remain required.   |
| TM-10 | Content-addressed deduplication discloses another tenant's package through response shape or timing.                                              | Tenant-scoped APIs never expose GCS keys, generations, or whether an object already existed; existing-object reuse verifies both archive and logical package identity. Cross-tenant tests prove identical archives use separate tenant-hashed objects and response shapes disclose no reuse.                                                  | Keep tenant-isolation and response-disclosure coverage required in release CI.           |
| TM-11 | A compromised renderer, old client, or arbitrary RPC caller sends credentials, local paths, unknown opcodes, or unsupported operations to a host. | Main owns auth tokens and grants; remote requests use strict schemas and capabilities; package transfer is separate from install; no stream opcode was added; mixed versions fail with update-required results.                                                                                                                               | Real client-newer/server-newer and SSH parity gates remain required.                     |
| TM-12 | Transfer replay, overlap, disconnect, or abandoned staging consumes disk or commits different bytes.                                              | Session count, idle time, total bytes, and chunk size are bounded. Offsets are monotonic, identical retry is idempotent, changed replay fails, commit hashes the exact staged file, and cancellation/disconnect cleanup is bounded.                                                                                                           | Exercise offline-GCS and real disconnects at every transfer boundary.                    |
| TM-13 | Provider aliases or junctions escape canonical storage or point at external content.                                                              | POSIX aliases are relative from real parents, Windows junctions use absolute canonical targets, targets are revalidated, and unowned/broken/external links are conflicts. Copy fallback is independently hashed and receipt-owned. Real Windows and WSL coverage includes existing, broken, external, denied, and drifted placement behavior. | Preserve the physical placement matrix in release coverage.                              |
| TM-14 | Skill instructions or scripts are mistaken for trusted Orca code or executed during install.                                                      | Share/install previews identify author, organization, scripts, executable files, digest, and version. Installation never runs scripts. Trust copy says the package is code from its author.                                                                                                                                                   | Security and design must approve the final trust wording and accessibility behavior.     |
| TM-15 | Telemetry, logs, or support bundles leak instructions, filenames, paths, ACLs, grants, policies, or credentials.                                  | Desktop install diagnostics map values to bounded categories before tracing. Deployed staging logs contain route templates and bounded request metadata only, and the logging exclusion removes bearer URLs. Support-bundle tests inject private canaries and prove they are absent from collected output.                                    | Preserve deployed-log and support-bundle privacy checks for future changes.              |
| TM-16 | Permissive staging permissions expose package bytes to another local user.                                                                        | Package archives, downloads, extraction, relayed uploads, locks, journals, and receipts use owner-private modes on POSIX; Windows uses owner-profile paths and inherited ACLs. Existing POSIX download roots are tightened before use. Real Windows, WSL, Ubuntu-floor, and SSH validation passed.                                            | Preserve owner-private staging checks across supported hosts.                            |
| TM-17 | Deletion, revocation, retention, or user departure leaves unauthorized grants or unrecoverable metadata/blob divergence.                          | Revocation blocks new grants immediately; existing grants expire within five minutes. Database references govern final deletion, quarantine lifecycle cleans abandonment, and GCS soft delete supplies recovery. Local installs remain independent.                                                                                           | Approve departure/legal-retention policy and exercise coordinated database/GCS recovery. |
| TM-18 | Broad IAM, public bucket access, service-account keys, or a compromised deployment identity bypasses application authorization.                   | Uniform bucket access, public-access prevention, bucket-scoped object access, service-account-scoped signing, skill-secret-only access, Cloud SQL client role, no desktop IAM, and no long-lived keys are Terraform-defined.                                                                                                                  | Review the staging and production plans and verify live IAM before rollout.              |
| TM-19 | Unbounded validation or request concurrency causes memory, CPU, database, storage, or egress denial of service.                                   | Fixed streaming buffers, package limits, per-instance finalization semaphore, rate/quota limits, bounded transfer sessions, Cloud Run instance limits, lifecycle cleanup, and independent kill switches constrain work.                                                                                                                       | Complete load testing, dashboards, alerts, and budget thresholds.                        |
| TM-20 | Operator recovery, diagnostics, or legal workflows bypass tenant isolation or leak content.                                                       | Runbooks require generation-specific recovery, coordinated PostgreSQL/GCS restoration, audited lifecycle actions, and no package contents in normal logs.                                                                                                                                                                                     | Security/privacy approval and restricted break-glass procedure remain required.          |

## Required review evidence

Security and privacy approval must not rely on this document alone. Reviewers need:

- Package/admission schemas and stable failure categories.
- Archive parser, extraction containment, transaction, provenance, and removal tests.
- Cloud authorization, object-generation, tenant-isolation, deletion, and recovery tests.
- Terraform plans plus live staging IAM, bucket, Cloud Run, Secret Manager, and Cloud SQL evidence.
- Real macOS, Linux-floor, Windows, WSL, paired-runtime, mixed-version, and SSH results.
- Captured staging logs, metrics, traces, and support bundles with seeded private canaries absent.
- Load-test results and independently tested upload, download, and remote-install kill switches.

Approval owners record findings and accepted residual risks outside this implementation document.
The external rollout gate remains closed until those findings are resolved or explicitly accepted.
