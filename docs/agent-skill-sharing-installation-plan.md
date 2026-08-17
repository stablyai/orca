# Agent skill sharing and installation plan

Status: implementation and validation in progress.

Last updated: 2026-08-12.

Implementation checklist:
[Agent skill sharing implementation checklist](./agent-skill-sharing-implementation-checklist.md).

Architecture decision:
[Agent skill sharing upstream boundary](./reference/agent-skill-sharing-upstream-boundary.md).

Provider registry:
[Agent skill provider paths](./reference/agent-skill-provider-paths.md).

## Decision summary

Orca will own a focused Skill Bundle packaging and installation pipeline for private sharing. A
bundle contains one or many skills; sharing one skill is the same flow with one selected item.

The community [`vercel-labs/skills`](https://github.com/vercel-labs/skills) project will
remain a behavioral reference, not a runtime dependency or source donor. Its npm package
exposes a CLI rather than a supported programmatic API, and its install/update behavior does
not provide the transaction, provenance, or private-package semantics Orca needs.

Orca will:

1. Package one or many local skills into one immutable, content-addressed artifact and durable
   link.
2. Store private artifacts behind unlisted, revocable Orca Cloud share records.
3. Treat possession of an active share link as recipient authorization, then resolve it into a
   short-lived download grant.
4. Execute installation on the machine that will use the skill.
5. Validate, stage, commit, and verify the package without silently overwriting local work.
6. Let the recipient install all or a selected subset, with conflicts and results reported per
   skill.
7. Install each selected skill once into `.agents/skills` and add aliases only for detected agents
   that need provider-specific paths.
8. Record bundle/version provenance independently from the community CLI's lockfiles.
9. Keep every share unlisted: bundles are reachable only through their durable link and never
   appear in search, browse, organization-library, or marketplace surfaces.
10. Give authenticated owners a private active-link inventory for copy and revocation; this is a
    management surface, not recipient discovery.

The portable archive root follows Agent Plugins 1.0.0 for a skills-only package. Orca does not
present Skill Bundles as a new executable plugin system: MCP servers, hooks, processes, connectors,
and permissions are out of scope. Loose-skill installation remains the universal/default delivery
path, with provider-native plugin adapters generated only where they improve compatibility.

The first release will support Orca package sources only. Arbitrary Git, npm, and community
registry sources remain delegated to existing tools until there is a product need to own
that larger package-manager surface.

## Current execution status

The Orca implementation is on `skills-share` through `2a0b7b2acf`; no Orca pull request exists.
The local working tree also contains the install-IPC compatibility fix and the in-progress Skills
UI overhaul. Cloud bundle ingestion, bearer links, recovery, load testing, production bootstrap,
OIDC smoke, and monitor ownership merged through `stablyai/orca-cloud#361`. Final infrastructure
hardening merged in `#364` as `57c4958979fc32ed4753959cea45edd3a7c8775c`.

Production is live. Two reviewed targeted Terraform phases added the dedicated app deploy identity,
restricted both GitHub WIF providers to exact workflows, added resource-scoped API/Auth/monitor and
Relay bindings, then removed five broad legacy bindings. A separate exact plan updated only the
bearer request-log exclusion and all eight skill alert policies; the alerts use the dedicated
`Orca skill sharing alerts` email channel. No full production plan was applied because it contains
unrelated Relay drift.

Production deploy run `31661421728` promoted `orca-cloud-api-00025-qup` at 100% traffic from merged
`main`, using immutable digest
`sha256:e4f044105ff2345574bdceb36eec1629761428cc2edf9d743939390b857d61e0`. Candidate and canonical
authenticated artifact and skill smoke passed, `/health` and `/ready` are green, and the direct
unlisted landing route returns only generic install copy plus the Orca deep link with `no-store`,
`no-referrer`, and restrictive CSP headers. Monitor execution
`orca-cloud-skill-storage-monitor-lfd26` passed on the same digest and emitted only aggregate
inventory. The implementation checklist records the remaining desktop and physical-host gates.

The final reliability hardening gives every skill Cloud request a default deadline, makes bundle
extraction cancellable and recoverable through the durable extraction journal, bounds package and
preview fanout, atomically caps concurrent share preparation, removes abandoned private staging,
and waits for SSH transaction recovery before install management. Paired clients advertise the
additive install-result capability so cancellation remains cancellation across mixed versions.
Regression coverage includes a real killed child process with partially extracted private bytes
and bounded 17-skill remote preview fanout. Full Node, CLI, and web typechecks plus repository lint
and reliability gates pass at that baseline.

The final combined physical `windows 2` run at `44d1266641` passed 449 tests across 67 files with
17 intentional platform skips while native-Windows, real-process, and Ubuntu 24.04 WSL coverage
were enabled together. Windows harness fixes at `97b831dd17` made recovery evidence path-semantic
and time-deterministic. The run exposed and fixed a WSL alias edge at `44d1266641`: when native UNC
`lstat` misses an existing distro symlink, Orca now verifies the alias through WSL and uses
`ln -sT` for creation. The Windows checkout was clean and WSL `/tmp` had no test debris. Only
Ubuntu 24.04 is installed; second-distro permutations are post-launch rather than a first-release
gate.

The release workflow now runs the exact unpacked Linux package under Electron-as-Node in an
Ubuntu 20.04 container and requires packaged `node-pty` to spawn `/bin/sh`. A physical x64 build at
`f1dccb4f42` passed the existing 18-binary ABI scan and this load/spawn smoke. A native ARM64 build
at `abe92d565b` then passed the same scan for all 18 bundled binaries and emitted
`orca-node-pty-floor-ok` from an ARM64 Ubuntu 20.04 container on native `aarch64` hardware. The
isolated ARM64 GCE builder had no service account or scopes, remained clean at the exact source
commit, and was deleted with its auto-delete boot disk after verification. The physical runs also
caught and corrected assumptions about the Linux executable name and packaged runtime-module
location before the gate protects a real release.

Cloud verification now requires a disposable PostgreSQL 16/17 migration-and-restore drill. An old
migration process remains connected while a future-additive process advances the schema; both
write successfully, the database is dumped and restored, and both write again against the restored
copy. PR run `31624484826` and merged-main run `31624717796` passed all code, Terraform, and
database jobs. The drill is localhost-only, cleans both schemas and its backup, and does not touch
staging or production services.

The local redesign now has an independently implemented Agent Plugins 1.0.0 skills-only bundle
manifest, deterministic one-or-many archive creation, bounded bundle extraction, additive bundle
install contracts, per-skill conflict/results orchestration, and bundle provenance on installed
skill receipts. The recipient dialog now recognizes bundle versions, defaults to all skills,
supports subset selection, previews aggregate destination state, keeps conflicts local by default,
and groups per-skill outcomes with failed-only retry. Local and paired-runtime bundle grants use the
additive bundle RPC with staged-upload fallback. SSH now uses a separately advertised additive
bundle relay method with the same direct-download and staged-upload fallback; older hosts are
rejected before transfer. The original single-skill path remains active for legacy shares while
bundle management migrates.

Cloud bundle ingestion accepts both envelopes during migration and stores the detailed bundle
manifest with the immutable version. Active share IDs are the recipient credential, owner
operations remain authenticated, and legacy ACL rows remain only as migration storage. A
Terraform-managed Cloud Logging exclusion prevents per-link Cloud Run request URLs from being
stored while privacy-safe route-template telemetry remains available.

The latest resilience pass adds bounded convergence after a lost final install response for both
paired runtimes and SSH. A staged retry creates a new upload instead of reusing a consumed upload.
SSH now carries only schema-validated structured skill failures through optional JSON-RPC
`error.data`, while older peers continue to ignore the field and newer clients fall back safely
when it is absent. Invalid gzip input has a stable archive category, and deterministic `EACCES`
and `ENOSPC` injection proves failed updates preserve the previous installed version.

Desktop skill operations now have privacy-bounded local diagnostic spans for package creation,
Cloud upload and finalization, grant download, client-mediated runtime and SSH transfer, single
and bundle installation, provider placement, transaction rollback settlement, and startup
recovery. They record aggregate bytes/files, phase duration, OS, destination and transport,
conflict/topology/mechanism outcomes, copy fallback, capability absence, recovery/orphan counts,
and bounded error categories without paths, skill names, contents, share URLs, grants, host IDs,
or credentials. Bundle summaries are aggregate and cap error-category cardinality at 32. This is
not product telemetry and changes no RPC, persisted state, or remote opcode, so old clients and
hosts remain compatible. The release suite passes 427 tests, full typecheck/lint pass, and the
real-process macOS crash-recovery matrix passes all 17 boundaries; physical platform reruns remain
tracked in the checklist.

The dedicated staging bucket, IAM, database, principal, enabled secret version, metrics, dashboard,
and alerts exist in `onorca-cloud-staging`. The complete skill-infrastructure target is zero-diff.
After `#314`, the targeted Auth/API plan also reports zero intended changes. Known shared Cloud SQL
and artifact-bucket drift was excluded and never applied. Staging was awakened only through guarded
run `31534564230`. Sleep run `31536547916` returned all three cells to zero; read-only status run
`31537525219` independently confirmed SQL policy `NEVER`, zero MIG targets, and zero managed Cloud
Run active-revision minimums.

The API release workflow now deploys an immutable no-traffic candidate with the complete artifact
and skill environment plus exactly one approved skill-database secret. It verifies the inherited
Terraform runtime identity, Cloud SQL attachment, scaling, resources, volumes, mounts, ports, and
probes before promotion, and rolls back to a re-smoked prior revision on failure. Staging now has
all four controls enabled; production keeps all four disabled. Database migration startup uses a
transaction-scoped advisory lock; transactional rollback and eight concurrent callers pass against
PostgreSQL 16 and 17.

Cloud PR `#344` passed both required checks and merged as `fcf8655a`. It adds privacy-bounded
migration-ready and migration-failure metrics, a migration lifecycle dashboard panel, and a
zero-tolerance migration-failure alert. A read-only targeted staging plan creates only those
metrics and alert, updates the existing skill dashboard, reruns descriptor propagation, and
destroys no infrastructure; staging remained asleep and nothing was applied.

Cloud PR `#345` passed both required checks and merged as `06a5c729`. It completes the initial API
dashboard coverage with explicit finalization-saturation and archive-rejection series and displays
successful and failed operations as rates. Malformed compression errors now become the bounded
`skill_package_archive_invalid` category before they reach persistence, responses, or telemetry.

Cloud PR `#346` passed both required checks and merged as `8199c048`. The Cloud Run dashboard and
alerts now cover route-template-scoped p99 skill latency, server errors, CPU, memory, and active
instance pressure. Alerts require five minutes above 80% p99 CPU/memory, more than 80% of the
configured instance ceiling, five-second interactive p99, or 30-second finalization p99; no bearer
URL or identifier becomes a metric label.

Cloud PR `#347` passed both required checks and merged as `65320475`. It adds a six-hour aggregate
storage inventory job, fixed-namespace bytes and object-count metrics, overdue-quarantine and job
failure alerts, and storage dashboard panels. The monitor identity has only
`storage.objects.list`; its scheduler identity can invoke only that job. A reviewed targeted
staging apply added 18 observability resources, updated the existing dashboard, and replaced only
the inert metric-propagation timer. The post-apply targeted plan is zero-diff. A manual execution
completed successfully and emitted only aggregate published and quarantine measurements, with
zero overdue objects and no identifiers or paths. SQL remained `NEVER`/`STOPPED`, all three Relay
MIG targets remained zero, and production remained disabled and untouched.

A separate read-only production prerequisite check confirmed that
`onorca-cloud-skill-packages` is currently unallocated, the production skill database and secret
names do not collide, and the intended API service and runtime identity already exist. Cloud Run
quota headroom exceeds the existing 20-instance API ceiling; V1 adds no database instance and
requires no quota increase. No production resource was planned or changed.

Auth deploy run `31535179937` promoted `orca-cloud-auth-staging-00017-dug` with exact staging-only
GitHub OIDC constraints, healthy JWKS, and zero deployment-window errors. API run `31535438327`
promoted `orca-cloud-api-staging-00042-hef` with `authenticatedSmoke: true` and `skillSmoke: true`.
The ten-minute, non-refreshable smoke principals exercised artifact CRUD and skill upload,
finalize, immutable versions, recipient/outsider authorization, local and remote grants, rollback,
expiry, revocation, deletion, and signed-object cleanup. Structured skill logs exposed only
privacy-safe request metadata and produced zero sensitive-value matches.

Cloud PR `#320` passed PR run `31564069382`, merged-`main` run `31564235724`, and a targeted
staging logging-exclusion plan of one addition, zero changes, and zero deletions. Guarded wake run
`31564370807` prepared staging. Deploy run `31564803943` promoted
`orca-cloud-api-staging-00051-yoq` at 100% traffic with immutable image digest
`sha256:511c0196511d2079bd9138092ad3cf065304b46a089b02d8df9318e0ae2e656a`. Candidate and canonical
smoke covered owner upload/finalize/share creation/inventory/revocation and anonymous preview,
local/remote download grants, version selection, expiry, uniform unavailable responses, package
deletion, and cleanup. Requests with no Authorization header and an invalid header returned the
same non-cached `404`; the serving revision produced zero errors, and Cloud Logging retained zero
per-link platform request logs. Cloud PR `#329` and desktop run `31569902499` subsequently passed
the complete browser-free publish/install/conflict/update/rollback/revoke/remove/delete journey.
Cloud PR `#330` merged as `8045c85dad`; deploy `31579844413` promoted revision
`orca-cloud-api-staging-00057-kat`, and recovery smoke `31580071168` proved generation-aware GCS
soft-delete restoration, transactional reference repointing, bearer download, and cleanup.
Guarded sleep `31580339694` restored SQL to `NEVER`/`STOPPED` and all Relay MIG targets to zero.
Load run `31585710645` then exercised 12 concurrent 30-skill bundles at roughly 3.95 MiB extracted
per bundle. Explicit saturation bounded ten requests while two completed; API, Cloud SQL, instance,
and latency metrics stayed far below their reviewed thresholds. PR `#335` made retry settlement
cleanup-safe, and run `31586684354` removed the exact failed-wave package set before two
manifest-proven quarantine generations were deleted with GCS preconditions. Guarded sleep
`31587083752` then returned SQL to `NEVER`/`STOPPED`, all three stable Relay MIGs to zero, and every
active Cloud Run revision minimum to zero. Guarded wake `31589384191` later restored only the two
configured Relay cells, and Auth deploy `31589963244` promoted
`orca-cloud-auth-staging-00025-zuz`. The browser-free physical `windows 2` staging journey then
passed publish, native Windows install, update, independent local version selection, rollback,
revocation preservation, removal, and Cloud deletion using encrypted credential run
`31591275227`; its ciphertext artifact and one-time local key material were deleted immediately.
Guarded wake `31603249983` later restored only the two configured cells. A disposable
no-service-account Ubuntu 20.04/glibc 2.31 VM passed the full live SSH staging lifecycle in 31.3
seconds, including host-owned install, update, rollback, revocation preservation, removal, and
Cloud deletion. The encrypted credential artifact, one-time keys, Orca SSH target, remote install,
and VM were removed. Guarded sleep `31604391897` passed and independent reads confirmed SQL
`NEVER`/`STOPPED` plus all three Relay MIGs at stable target zero. Guarded wake `31605729090` then
enabled the same topology for an isolated headless paired host with a separate home/profile. The
full paired-runtime staging lifecycle passed in 12.5 seconds without local fallback, and its
environment, install, Cloud package, encrypted credential artifact, and one-time keys were
removed. Guarded sleep `31606600532` passed with the same independently verified low-cost state.
The owner accepted the additional live physical WSL Cloud journey as duplicate release evidence on
2026-08-12 after the combined 449-test Windows/WSL matrix and native-Windows Cloud lifecycle passed;
this does not collapse WSL semantics into macOS. Remaining staging gates are physical SSH
macOS/Windows and the time-gated quarantine lifecycle deletion. The Windows/WSL release matrix is
green.
Guarded wake retry `31630802215` succeeded before that decision. The first cleanup attempt
`31631288043` failed closed during Terraform provider download on an upstream `503`, before its
mutation step; guarded sleep retry `31631379891` succeeded. Independent reads verified SQL
`NEVER`/`STOPPED`, all three Relay MIGs stable and reached at target zero with no active actions,
and zero minimum instances on each active API, Auth, and Relay revision.
Guarded wake `31634214856` later restored the configured topology for an isolated native macOS
ARM64 OpenSSH target whose home, keys, and relay state lived under one temporary root. The full
publish/install/update/rollback/revoke/remove/delete staging lifecycle passed in 20.1 seconds
without local fallback. The run also corrected the test oracle to support valid absolute POSIX SSH
homes outside `/home`. The encrypted GitHub artifact was deleted immediately; the SSH service,
relay, install, temporary home, and one-time key material were removed. Guarded sleep
`31635145830` passed, and independent reads confirmed SQL `NEVER`/`STOPPED`, every MIG stable at
zero with no active actions, and API/Auth/Relay minimum scale zero. Supported Windows SSH and the
time-gated quarantine deletion remain open.

Cloud PR `#355` removed internal publisher and organization identifiers from recipient responses,
passed code, Terraform, and PostgreSQL 16/17 checks, and merged as
`b3213bd34d1b224d8a3b11527eceaac883965400`. Guarded wake `31639920301` prepared staging. Deploy
`31640677572` promoted `orca-cloud-api-staging-00060-qay` at 100% traffic with immutable digest
`sha256:31cb0a91a7abf1f82e4de08bd31e98fbd71519adc731a005fc95f60480658f73`; authenticated and skill
candidate/canonical smoke passed. Its unrelated post-promotion storage-monitor image update lacked
`iam.serviceAccounts.actAs`; the prior monitor image remains serving and unchanged. Guarded sleep
`31640935616` passed in 8m51s; independent reads verified SQL `NEVER`/`STOPPED`, all three Relay
MIGs stable and reached at target zero, and the API at minimum scale zero while revision
`00060-qay` retained 100% traffic.

Production deployment completed on 2026-08-12. The exact skill-only Terraform apply created the
private bucket, database, secret, least-privilege identities, request-log exclusion, metrics,
alerts, and dashboard with 40 additions and zero updates, replacements, or deletions. Disabled-route
bootstrap run `31648015091` migrated the schema and promoted `orca-cloud-api-00016-yem` while all
four controls remained false. Cloud PR `#357` enabled all four controls in one launch. Cloud PR
`#358` replaced the missing long-lived production smoke secret with an exchange restricted to the
exact production `main` workflow, GitHub environment, dispatch event, repository/owner IDs, and
audience; issued principals expire in ten minutes and have no refresh credentials. Auth run
`31649381596` passed candidate and canonical health. API run `31650178315` passed candidate and
canonical authenticated artifact plus skill lifecycle smoke, promoted
`orca-cloud-api-00022-maq` to 100% traffic, and completed the aggregate monitor image update. All
four skill controls are true, the serving revision reported zero deployment-window errors, and
both API and Auth health are green.

Cloud PR `#359` codified the deploy identity's `roles/iam.serviceAccountUser` grant only on the
read-only skill storage monitor identity. Its exact production apply added one resource with zero
changes or deletions, and the repeat targeted plan was zero-diff. Manual execution
`orca-cloud-skill-storage-monitor-bmm4q` completed successfully. Cloud PRs `#360` and `#361` keep
Terraform ownership of the monitor shape while assigning its immutable image and Cloud Run client
metadata to the release workflow; the exact production monitor plan is zero-diff after the live
image advance. The development Orca instance
`skill-sharing-manual` now points at `login.onorca.dev` and `cloud-api.onorca.dev`; sign-in and the
desktop/real-host production lifecycle remain user-driven validation.

A final renderer lifecycle review fenced managed-install inventory by request generation so a
slower previous machine cannot overwrite the newly selected machine's list. It also moved bundle
busy propagation into the initiating event instead of mirroring state through an effect. The
renderer skill/settings slice passed 122 tests across 18 files plus all Node/CLI/web typechecks,
focused lint, changed-code quality, max-lines, diff, and localization gates.

## Research baseline

The upstream assessment used `vercel-labs/skills` commit
`c6f69c631292444cc541ac6d91e2226b0ff247da`.

The portable bundle assessment used
[`agentplugins/agent-plugins-spec`](https://github.com/agentplugins/agent-plugins-spec) commit
`bd383552095128f6effe895b9257cfd580a6d179`, specifically `spec/1.0.0.md`. The local reviewed clone
is `/Users/jinwoo/refs/misc/agent-plugins-spec`; the example repository is
`/Users/jinwoo/refs/misc/agent-plugins-example`. Orca independently implements the reviewed
behavior. The specification prose is CC BY 4.0 and its schemas/software are Apache 2.0, so Orca
will not copy the prose or vendor the schemas unless the corresponding notices are deliberately
handled.

Useful upstream behavior:

- A canonical `.agents/skills/<name>` location.
- A data set of agent-specific global and project paths.
- Relative symlink handling, Windows junction behavior, and copy fallback.
- Archive path, entry-count, and extracted-byte limits.
- Tests for aliases, broken links, and provider-specific placement.

Behavior Orca will not inherit:

- Deleting the destination before the replacement is ready.
- Updating without checking whether installed files were modified.
- Direct read/modify/write lockfile updates without durable publication.
- Reinstalling the canonical directory once per selected agent.
- Treating an expiring signed artifact URL as package identity.
- Coupling installation to prompts, terminal output, telemetry, and process exits.

Orca will not copy upstream source, tests, fixtures, or registry entries. Provider paths will be
implemented independently from official provider documentation and verified installations. Under
that constraint, Orca does not incorporate upstream copyrightable material and needs no upstream
attribution. Revisit this decision if implementation work ever proposes copying material.

## Goals

- Share one or many private skills with a teammate through one durable, intuitive link.
- Select and review large bundles, including groups of 30 skills, without repetitive dialogs.
- Install on the local computer or any compatible connected Orca runtime.
- Support global scope and folder-workspace/project scope.
- Work on macOS, Linux, and Windows.
- Preserve executable bits and all files in the skill package.
- Prevent archive traversal, symlink escapes, special files, case collisions, and resource
  exhaustion.
- Never silently replace an unowned or locally modified skill.
- Recover from interruption during package download, extraction, placement, alias creation,
  or provenance publication.
- Keep share authorization separate from short-lived blob access.
- Support immutable versions, updates, removal, and eventual team-wide reconciliation.
- Remain compatible with independently updated desktop clients and remote Orca servers.
- Treat ordinary folder workspaces as first-class; Git is not required.
- Preserve enough portable metadata for export, SSH/remote transfer, and offline validation.

## Non-goals for the first release

- Reimplementing all `skills` CLI source parsing and provider integrations.
- Supporting all upstream agent paths on day one.
- Publishing package bytes through a permanent or directly addressable blob URL.
- Automatically installing a shared skill on every organization machine.
- Merging local modifications with a newer shared package version.
- Treating installation as a security sandbox. A skill contains instructions and scripts and
  must be presented to the user as code from its author.
- Shipping a full plugin runtime, MCP servers, hooks, processes, connectors, or portable
  permissions.
- Requiring a provider-native plugin installer; unsupported agents still receive loose skills.
- End-to-end encryption from Orca Cloud operators in the initial trust model. Private means
  unlisted and accessible through an active bearer link, with authenticated owner management.
  Application-level package encryption can be added later without changing package identity.

## Product experience

### Sharing

The existing Skills page has three header actions: **Share skills**, **Install from link**, and
**Manage**. **Share skills** enters selection mode across installed and workspace skills. Search
and filter changes retain selections; **Select all results** is explicit and Orca never silently
selects everything. The existing per-card share action remains a one-skill shortcut.

Ineligible skills are disabled with a visible reason. Duplicate skill names must be resolved before
publication because they would collide in both the archive and destination roots.

The review dialog shows:

- Bundle name and selected skill list.
- Skill, file, and byte counts.
- Included scripts and executable files, with an expandable review for each skill.
- The signed-in profile that will own and manage the share.
- A clear warning that anyone with the unlisted link can inspect and install the bundle.
- Optional version label and release notes.

After confirmation, Orca validates and packages the exact bytes shown in the preview. Progress is
named **Preparing skills**, **Uploading**, **Verifying**, and **Publishing link**. Completion returns
one durable URL such as:

```text
https://app.orca.dev/skills/share/<share-id>
```

The URL identifies a revocable bearer share record, not a blob-storage object or permanent GCS
grant. Recipients do not sign in: possession of an active, unexpired link authorizes inspection and
a short-lived download grant. Revocation blocks future resolution and grants, while already
installed copies remain. Publishing, listing owned shares, version management, revocation, and
deletion still require the owner to sign in.

### Installing

Opening a deep link launches Orca and inspects the bundle without installing it. Preview identifies
the immutable version, release notes, skill count, scripts, and executable files. V1 deliberately
omits publisher identity from the recipient response and UI; internal creator and tenant records
remain private authorization and management data. The recipient can select all or a subset of the
contained skills.

The destination picker supports the local machine, paired runtimes, WSL, and SSH, in global or
workspace scope. Before commit, the preview groups selected skills as new, unchanged, updates, or
conflicts and shows detected-agent coverage. Conflicts are handled per skill in one review surface,
not one dialog per conflict. **Keep local** is the default; replacement is explicit. The primary
action says **Install N skills**.

Installation shows aggregate progress plus the current skill. Results are grouped as installed,
unchanged, kept local, and failed; failed items can be retried without repeating successful work.
An incompatible selected runtime receives an update-required result before transfer.

**Manage** separates:

- Installed bundles: update, rollback, install on another machine, inspect skills, and remove.
- Shared bundles: copy link, revoke, publish version, and delete the Cloud package.

Settings includes a **Share Skills** section, parallel to **Artifacts**, explaining unlisted-link
behavior, retention, revocation, and the fact that installed copies are unaffected. It links to the
Skills page for publishing and management; it does not introduce a searchable catalog or a second
sharing workflow.

Bundle update or removal never silently destroys locally modified skills.

The UI must follow `docs/STYLEGUIDE.md` and use existing design tokens and shadcn primitives.

## Target architecture

```text
Selected skill folders
    |
    v
Package builder -- validates and creates immutable artifact
    |
    v
Orca Cloud -- private blob + version metadata + revocable bearer share
    |
    v
Download grant -- short-lived and scoped to one immutable digest
    |
    v
Destination runtime
    |
    +-- package ingress
    +-- package inspection
    +-- per-skill selection and install planning
    +-- staged transaction
    +-- provider placement reconciliation
    +-- bundle and per-skill provenance publication
    +-- post-install discovery
```

Cloud download, client-mediated transfer, and a local package file all terminate at the same
validated package-ingress boundary. Installation logic does not know which transport supplied
the bytes.

## Package format

Use a versioned tar archive so executable modes can be represented without a platform-specific
side channel. The extracted archive root is an Agent Plugins 1.0.0-compatible, skills-only plugin:

```text
plugin.json
skills/
├── skill-a/
│   └── SKILL.md
├── skill-b/
│   └── SKILL.md
└── ...
dev.orca.skill-sharing/
└── manifest.json
```

Conceptual manifest:

```ts
type SkillBundleManifestV1 = {
  schemaVersion: 1
  packageId: string
  versionId: string
  bundleName: string
  description: string
  createdAt: string
  skills: Array<{
    id: string
    name: string
    description: string
    digest: string
    files: Array<{
      path: string
      size: number
      executable: boolean
      sha256: string
    }>
  }>
  bundleDigest: string
}
```

Rules:

- `packageId` is stable across versions; `versionId` identifies one immutable publication.
- `plugin.json` uses the canonical Agent Plugins 1.0.0 `$schema`, a valid portable plugin name,
  bundle version, description, and optional standard metadata. Orca validates from locally owned
  rules and never fetches the schema while loading.
- Every immediate `skills/<name>/SKILL.md` is required and must parse successfully.
- Each skill digest uses normalized relative paths, executable state, classification, and file
  identity. The bundle digest commits to the ordered skill identities and their globally unique
  archive paths.
- The installed folders receive only the selected children of `skills/`.
- Bundle identity, access, immutable versions, upload/download, update/rollback, and Cloud deletion
  are bundle-level. Conflict handling, provenance, selection, local-modification protection, and
  results are skill-level.
- Paths use `/` in the manifest and are converted with the executing host's path API.
- LF and CRLF non-executable text share one normalized package identity, while each immutable
  archive retains and hashes its exact source bytes; executable and binary files always use exact
  bytes for identity.
- Names are normalized once during publication. Installation never silently renames a conflict.
- The archive has no outer `bundle/` wrapper, so its root remains directly consumable by agents
  that implement Agent Plugins.
- Orca-specific integrity and version data lives in `dev.orca.skill-sharing/manifest.json` rather
  than a top-level custom field or GCS metadata alone. It therefore survives export, SSH/remote
  transfer, and offline validation and can describe every skill and file.
- GCS custom metadata stays compact and operational. PostgreSQL stores only the package, share,
  version, ownership, and lifecycle records needed to resolve a known link or manage an owned
  bundle. Legacy ACL records may remain during migration but never gate bearer-link access.
- Orca constructs a fresh staging root. If imported content already contains
  `dev.orca.skill-sharing`, Orca accepts only an appropriate recognized schema and rejects unknown,
  malformed, or conflicting contents; it never overwrites the namespace silently.
- V1 rejects symlinks and special files. A later package-builder feature may safely dereference
  internal links after proving they remain within the source root.
- Existing limits remain the starting contract: depth 16, 2,048 entries, 512 files, 4 MiB per
  file, and 32 MiB total extracted bytes. Compressed download size also receives an explicit cap.
- Archive and manifest schema changes are additive or introduced as a new schema version.

The package builder observes every selected source, copies it into a fresh private staging root,
observes the staged copies again, and only packages them if every identity agrees. The preview
shown to the user is bound to that final bundle digest.

The original unpublished `manifest.json + skill/` staging format has no production compatibility
commitment. Orca will replace it before launch and migrate or discard staging-only records. Remote
bundle RPCs use a new `skills.install.bundle.v1` capability and additive methods so older peers do
not interpret bundle requests as single-skill requests.

## GCP deployment plan

### Existing production baseline

Read-only inspection of the active `onorca-cloud` project on 2026-08-11 found:

| Resource          | Existing state relevant to skill sharing                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud Run         | `orca-cloud-api`, `orca-cloud-auth`, `orca-cloud-relay`, and `orca-cloud-relay-fence` run in `us-central1`                                                                 |
| API service       | `orca-cloud-api` uses its own service account, scales from 0 to 20 instances, has a 300-second timeout, and already owns artifact-sharing endpoints                        |
| Object storage    | `onorca-cloud-artifacts` is a `US` bucket with uniform bucket-level access, public-access prevention, exact CORS for `https://share.onorca.dev`, and seven-day soft delete |
| Database          | `orca-cloud-auth-db` is PostgreSQL 17 in `us-central1`, regional/high-availability, with backups and point-in-time recovery                                                |
| Database contents | The instance currently contains `orca_auth` and `orca_relay` databases; there is no skill database                                                                         |
| IAM               | `orca-cloud-api@onorca-cloud.iam.gserviceaccount.com` owns objects in the existing artifact bucket                                                                         |
| APIs              | Cloud Run, Cloud Storage, Cloud SQL Admin, IAM Credentials, Secret Manager, Logging, Monitoring, and Pub/Sub are enabled                                                   |
| Excluded services | Firestore and Cloud Asset Inventory are disabled; Cloud Tasks is not enabled                                                                                               |

The GCP inspection was read-only. Commands that offered to enable disabled APIs were declined, and
no resources or IAM policies were changed.

### V1 infrastructure decision

Use the existing project, API service, authentication service, PostgreSQL instance, deployment
pipeline, and Terraform state. Add a dedicated package bucket and database instead of putting
private skill packages into the existing general artifact namespace.

The V1 control plane remains in `orca-cloud-api`. Package validation is bounded and streaming, so a
separate worker service is not justified at the initial 40 MiB compressed-package ceiling. Protect
the existing API workload with a small per-instance package-finalization semaphore and return a
retryable response when that lane is full.

Split package processing into a dedicated Cloud Run service later if finalize latency or CPU usage
interferes with artifact sharing. Do not reduce the entire API service's current concurrency merely
to accommodate one endpoint family.

Firestore is not required. Skill metadata belongs in PostgreSQL beside the existing Orca Cloud
identity model. Cloud Tasks and Pub/Sub are not required for V1 because upload expiry is enforced
by a GCS lifecycle rule and package finalization stays synchronous and bounded.

### Required GCP changes

All production changes are declared in the existing Orca Cloud Terraform configuration. Do not
create durable resources manually with `gcloud`.

| Change              | Proposed production value                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| GCS bucket          | `onorca-cloud-skill-packages`, subject to Terraform name validation                                                           |
| Location            | `US`, matching existing shared-artifact storage; revisit per-region buckets when data residency becomes a product requirement |
| Access              | Uniform bucket-level access and public-access prevention enforced                                                             |
| Soft delete         | Seven days, matching the current artifact bucket                                                                              |
| Object versioning   | Disabled; package keys are immutable and GCS generations are recorded                                                         |
| Temporary lifecycle | Delete `uploads/` objects after one day                                                                                       |
| CORS                | Exact approved Orca share/app origins; no wildcard origin                                                                     |
| Database            | `orca_skills` on `orca-cloud-auth-db`                                                                                         |
| Database principal  | Dedicated `orca_skills_app` user with access only to `orca_skills`                                                            |
| Database secret     | `orca-cloud-skills-database-url` in Secret Manager                                                                            |
| Cloud Run service   | Extend `orca-cloud-api`; mount the existing Cloud SQL instance and inject only the skill database secret                      |
| Package signer      | Reuse `orca-cloud-api@onorca-cloud.iam.gserviceaccount.com` for V1                                                            |
| Metrics/logging     | Extend existing Cloud Logging and Monitoring configuration with skill endpoint dashboards and alerts                          |

The bucket is separate because skill packages need different authorization, retention, signed
download, and lifecycle rules from public/shared artifacts. It also provides a clean IAM kill
switch without disrupting existing artifact links.

### Bucket layout

```text
gs://onorca-cloud-skill-packages/
  uploads/<upload-id>/package.tar.gz
  packages/v1/tenants/<tenant-hash>/sha256/<first-two-hex>/<archive-sha256>/package.tar.gz
```

Rules:

- `uploads/` is quarantine storage and is never downloadable through a share.
- Upload IDs are random, single-use, tenant-bound, and expire in PostgreSQL as well as GCS.
- Final package keys are derived from a one-way owner-tenant hash and the validated archive
  SHA-256. Raw tenant identifiers never appear in object names.
- The database records the final object's GCS generation, compressed size, archive SHA-256, and
  package digest.
- Final objects are never overwritten. Promotion uses a generation-match precondition.
- If a tenant's final key already exists, finalization verifies its archive SHA-256 and logical
  package digest metadata before reusing it.
- Deduplication is tenant-scoped in both GCS and PostgreSQL, so another tenant's matching archive
  cannot change publication timing or reveal that the digest already exists.
- GCS object versioning remains off; immutable keys plus stored generations prevent accidental
  replacement, while seven-day soft delete provides operator recovery.
- Deleting the final database reference deletes the object only after a transaction proves no
  package version still references it. GCS soft delete then supplies the recovery window.

### Upload implementation

Use a V4 signed POST policy rather than a signed unrestricted PUT. The POST policy enforces:

- Exact quarantine object key.
- `application/vnd.orca.skill+tar+gzip` content type.
- A content-length range capped at 40 MiB.
- Required upload ID and expected archive SHA-256 metadata.
- A 15-minute expiration.

The compressed limit is slightly above the 32 MiB extracted-file limit to allow tar metadata and
incompressible input. The package builder still enforces the lower extracted-content limits.

Upload sequence:

1. `orca-cloud-api` authenticates the user through the existing auth integration.
2. The API checks organization membership, package quota, per-user rate limits, and concurrent
   upload limits.
3. It inserts a pending upload row and returns a signed POST policy for the unique quarantine key.
4. The client uploads directly to GCS; package bytes do not traverse Cloud Run.
5. The client calls finalize with the upload ID and package manifest identity.
6. The API reads GCS object metadata and rejects unexpected size, content type, key, generation,
   or tenant binding.
7. The API streams the object once to calculate archive SHA-256 and validate the archive envelope,
   manifest, path set, file limits, and package digest. It never buffers the whole package.
8. The API promotes the validated object to its immutable content-addressed key with an
   if-absent generation precondition.
9. A PostgreSQL transaction publishes the immutable package version and marks the upload complete.
10. The quarantine object is deleted. The one-day lifecycle remains the backstop for abandoned
    uploads.

Run at most a small fixed number of finalizations concurrently per API instance. A full lane
returns `429` or `503` with `Retry-After`; it does not queue unbounded package bytes or work.

### Download grants

After resolving an active bearer share, `orca-cloud-api` creates a V4 signed GET URL with:

- Exact final object key and stored generation.
- Five-minute expiration.
- Response content type and attachment filename.
- No list or write permission.

The URL is the short-lived grant. The durable share URL is never signed directly and cannot access
GCS. Revocation cannot invalidate an already-issued GCS URL, so the five-minute lifetime is the
maximum revocation delay.

The destination runtime accepts download URLs only from the configured GCS origin for the Orca
skill bucket, rejects credential-bearing redirects to any other host, enforces the expected byte
count while streaming, and verifies both archive SHA-256 and package digest before installation.

### IAM

Apply least privilege at the dedicated bucket and service-account level:

- Grant the API service account `roles/storage.objectUser` on the skill-package bucket, not a
  project-wide storage role.
- Grant the API service account `roles/cloudsql.client` for the existing instance.
- Allow the API service account to use IAM Credentials `signBlob` for itself so it can generate V4
  policies and URLs without a downloaded service-account key. The Terraform binding is scoped to
  that service account.
- Grant Secret Manager accessor only for `orca-cloud-skills-database-url` and any future
  skill-specific secret.
- Keep bucket IAM free of `allUsers` and `allAuthenticatedUsers`.
- Do not give the desktop, remote runtime, or user identity direct bucket IAM. They receive only a
  time-bound signed operation after application authorization.
- Keep the existing deployment service account's impersonation/deploy permissions unchanged
  except where Terraform needs to manage the new resources.

No long-lived GCP key is shipped in Orca or stored on a remote runtime.

### PostgreSQL schema

Create migrations for:

- `skill_packages`: stable bundle identity, owner organization, slug/name, creator, timestamps,
  and deletion state.
- `skill_package_versions`: immutable version, package digest, archive SHA-256, GCS object key and
  generation, byte and skill counts, release notes, creator, publication state, and the validated
  bundle manifest needed to inspect a known share without downloading its private archive.
- `skill_package_uploads`: tenant/user binding, quarantine key and generation, expected identities,
  expiration, finalization state, and failure category.
- `skill_package_acl`: legacy organization or user access records retained for migration until a
  later schema cleanup; these do not authorize or deny bearer-share resolution.
- `skill_share_records`: unpredictable share ID, package ID, optional pinned version, expiration,
  revocation state, creator, and timestamps.
- `skill_package_audit_events`: bounded security/lifecycle event metadata without package contents
  or signed URLs.

Required constraints and indexes include:

- Unique package slug within its owning organization.
- Unique immutable version ID and package digest identity.
- Tenant-scoped archive identity and final GCS object key/generation pair.
- Share lookup by unpredictable ID and active/revoked state.
- No package, version, or contained-skill search/list index; share links are intentionally unlisted.
- Owner lookup for authenticated management operations.
- Pending-upload lookup by owner and expiration.
- Foreign keys that prevent removing a blob reference while a published version uses it.

Share resolution and share-scoped download grants accept no user credential: an unpredictable,
active, unexpired share ID is the bearer credential. Anonymous requests receive the same
non-disclosing `404` for missing, expired, revoked, or deleted shares and remain subject to
distributed per-IP abuse limits. Package/version management, share creation, owner listing,
revocation, and deletion require an authenticated owner.

### Cloud Run changes

Add skill endpoints to `orca-cloud-api` and configure:

```text
ORCA_SKILL_PACKAGE_BUCKET=onorca-cloud-skill-packages
ORCA_SKILL_PACKAGE_MAX_COMPRESSED_BYTES=41943040
ORCA_SKILL_PACKAGE_UPLOAD_TTL_SECONDS=900
ORCA_SKILL_PACKAGE_DOWNLOAD_TTL_SECONDS=300
ORCA_SKILL_PACKAGE_FINALIZE_CONCURRENCY=<small fixed value>
ORCA_SKILLS_DATABASE_URL=<Secret Manager reference>
```

Use the existing auth base URL and CORS-origin configuration. Do not add a second authentication
implementation for skills.

Every API image rollout must stamp the complete Terraform-owned literal environment and exact
`ORCA_SKILLS_DATABASE_URL` secret reference in one no-traffic candidate. Before smoke or promotion,
compare the candidate with both the reviewed release values and the serving Terraform runtime
shape. Reject any unexpected secret or environment entry, changed service account, Cloud SQL
attachment, scaling bound, resource limit, volume, mount, port, or probe. This keeps ordinary image
deploys from clearing the skill database secret or silently detaching Cloud SQL.

The API streams upload validation with fixed buffers under its existing 512 MiB memory limit. Load
test the finalize lane before choosing its fixed concurrency. Keep the current Cloud Run instance
scaling bounds initially, then adjust only from observed CPU, latency, database connection, and
error metrics.

Recommended endpoint family:

```text
POST   /v1/skill-packages/uploads
POST   /v1/skill-packages/uploads/<upload-id>/finalize
POST   /v1/skill-packages
GET    /v1/skill-packages/<package-id>
GET    /v1/skill-packages/<package-id>/versions
POST   /v1/skill-packages/<package-id>/shares
DELETE /v1/skill-shares/<share-id>
GET    /v1/skill-shares/<share-id>
POST   /v1/skill-shares/<share-id>/download-grants
```

Finalize may create the package/version in one call; the separate package endpoint remains useful
when publishing a new version under an existing stable package identity. All mutating endpoints
accept idempotency keys.

### CORS and public routing

- Route the endpoint family through the existing Orca Cloud API hostname and deployment path.
- Add only exact production and approved development app/share origins to the skill bucket's CORS
  policy.
- Allow `POST` for signed upload policy submission and `GET`/`HEAD` for signed download.
- Expose only required response headers such as `Content-Type`, `Content-Length`, `ETag`,
  `x-goog-generation`, and `x-goog-hash`.
- Do not expose the GCS bucket through a public custom domain.
- Keep Cloud Run ingress and authentication consistent with existing API endpoints; package
  authorization remains mandatory at the application layer.

### Retention, deletion, and recovery

- Pending upload database rows expire after 15 minutes and are safe to delete after one day.
- GCS deletes quarantine objects after one day regardless of database cleanup success.
- Published objects have no age-based deletion rule.
- Package deletion first marks metadata deleted and revokes shares, then deletes an object only
  when no retained version references it.
- Seven-day GCS soft delete allows operator recovery from accidental object deletion.
- PostgreSQL backups and point-in-time recovery cover metadata; restoration procedures must restore
  database rows and object generations consistently.
- Organization retention and legal deletion requirements override product rollback retention.

### Monitoring and operational gates

Add dashboards and alerts for:

- Upload grant, finalize, share resolution, and download-grant request rate.
- Authorization denials and rate-limit outcomes.
- Finalize duration, semaphore saturation, archive rejection category, and digest mismatch.
- Cloud Run 5xx rate, CPU, memory, instance count, and request latency for skill routes.
- GCS quarantine bytes, published bytes, object count, and lifecycle deletion failures.
- PostgreSQL connection count, storage, query latency, migration status, and failed transactions.
- Signed URL creation failures and IAM Credentials errors.
- Orphan metadata/object reconciliation count.

Budget alerts cover GCS stored bytes and egress, Cloud Run CPU/request growth, and Cloud SQL storage.
Logs contain package/version IDs and error categories, not manifests, filenames, share URLs, signed
policies, signed URLs, or ACL membership.

### Provisioning and deployment sequence

1. Confirm the existing Orca Cloud Terraform worktree and staging environment are current.
2. If there is no isolated staging GCP project, create or designate one before testing package
   upload; do not exercise new lifecycle/IAM behavior first in `onorca-cloud` production.
3. Add the bucket, lifecycle, CORS, IAM, database, database user, secret, Cloud SQL attachment, API
   configuration, dashboards, alerts, and budget thresholds to Terraform.
4. Run Terraform formatting, validation, and a reviewed plan. The expected production plan contains
   no replacement of the existing artifact bucket, Cloud SQL instance, or Cloud Run services.
5. Apply the reviewed skill-only infrastructure plan in staging without shared-resource drift.
6. Deploy `orca-cloud-api` with all skill controls disabled. When the database secret is present,
   startup applies PostgreSQL migrations without registering the skill routes.
7. Verify the migration-ready event, zero error logs, ordinary artifact behavior, and `404` skill
   route boundary before changing any control.
8. Enable route registration for the staging identity and run upload/finalize/download tests,
   including expired policies, anonymous bearer resolution, oversized uploads, corrupt archives, deduplication,
   revocation, and object cleanup.
9. Run a staging desktop-to-runtime installation and verify logs contain no grants or private
   contents.
10. Apply the reviewed production Terraform plan.
11. Run migrations and deploy the API with availability disabled.
12. After every release gate passes, enable the feature for all accounts in one launch.
13. Observe at least one complete soft-delete, upload-expiry, update, rollback, and revoke journey,
    retaining separate kill switches for upload grants, download grants, and remote installation.

Production verification uses read-only commands such as:

```bash
gcloud storage buckets describe gs://onorca-cloud-skill-packages --project=onorca-cloud
gcloud run services describe orca-cloud-api --region=us-central1 --project=onorca-cloud
gcloud sql databases list --instance=orca-cloud-auth-db --project=onorca-cloud
gcloud iam service-accounts get-iam-policy \
  orca-cloud-api@onorca-cloud.iam.gserviceaccount.com --project=onorca-cloud
```

Never print Secret Manager payloads or signed policies/URLs during verification.

## Installation scopes and destinations

### Global scope

The canonical root is resolved on the destination host:

```text
<home>/.agents/skills/<skill-name>
```

Provider-specific aliases are created only for detected agents that do not consume the canonical
root.

### Workspace scope

The canonical root is:

```text
<workspace>/.agents/skills/<skill-name>
```

The workspace may be a Git worktree or a plain folder. Resolution uses the workspace identity
owned by the executing runtime; a client-provided path alone is not trusted for a remote target.

Project installation does not create or modify a checked-in desired-state lockfile in V1. A
separate team-sync feature may later add an explicit, reviewable project manifest.

### WSL scope

WSL is a distinct execution target. Home resolution, path operations, package extraction, and
installation run inside the selected distro. The Windows client must not construct Linux home
paths or mutate the distro through translated Windows paths.

### SSH-only scope

An SSH target without an Orca runtime cannot execute the runtime RPC directly. Before GA, add a
host-side installation command invoked through the existing SSH execution and file-transfer
providers. The desktop uploads the immutable package through SFTP, invokes the bundled Orca
installer on the SSH host, and receives the same structured result as runtime RPC.

If the required host component is unavailable, Orca reports the limitation and provides a local
package download or command; it never installs into the desktop's home as a fallback.

## Provider destination strategy

Orca owns a small data-only registry for agents Orca supports. Each entry describes:

- Orca agent ID.
- Whether it reads the universal `.agents/skills` root.
- Global provider-specific path resolver when required.
- Project provider-specific path resolver when required.
- Detection evidence required before creating the path.
- Supported alias mechanism by platform.

The registry is authored from official agent documentation and Orca's own verified installations.
Upstream may reveal that a compatibility case exists, but its implementation, path table, and
tests are not copied or transformed into Orca code.

Policy:

1. Always create one canonical copy.
2. Do nothing else for universal agents.
3. Create an alias for a detected non-universal agent.
4. On Windows, prefer a directory junction when supported.
5. Fall back to a verified independent copy only when aliases are unavailable.
6. Record every placement and its topology.
7. Never create configuration roots for dozens of undetected agents.
8. Never replace an unowned provider-specific copy without an explicit decision.

Provider releases and official documentation are reviewed periodically. Orca's registry changes
only through normal review and platform tests; no upstream synchronization script owns it.

The portable root does not imply every agent can install it as a native plugin. Cursor can consume
the root `plugin.json` package directly. Claude expects `.claude-plugin/plugin.json`; Codex and
ChatGPT expect `.codex-plugin/plugin.json`; the Codex IDE extension does not currently support
plugins. Orca therefore installs loose skills by default and may generate provider-native adapters
for detected compatible clients:

- Cursor: use the portable package directly.
- Claude: generate `.claude-plugin/plugin.json` from validated bundle metadata.
- Codex/ChatGPT: generate `.codex-plugin/plugin.json` from validated bundle metadata.
- Other or unsupported agents: install the selected loose skills.

Native plugin installation never becomes the only path. Provenance connects every loose installed
skill to its source bundle and immutable version.

## Installer components

Create narrow modules with explicit responsibilities:

### Shared contracts

- `src/shared/skill-package-manifest.ts`: bundle manifest, portable plugin manifest, and canonical
  validation.
- `src/shared/skill-install-contract.ts`: bundle selection, per-skill preview, conflict, placement,
  and result types.
- `src/shared/skill-install-capability.ts`: runtime capability name and compatibility message.

### Main/runtime implementation

- `src/main/skills/skill-package-creation.ts`: source observation, stable staging, and archive
  creation.
- `src/main/skills/skill-package-extraction.ts`: bounded archive inspection and extraction.
- `src/main/skills/skill-package-download.ts`: grant validation, host allowlisting, streaming, and
  compressed-byte limits.
- `src/main/skills/skill-install-destinations.ts`: global, workspace, WSL, and provider path
  resolution.
- `src/main/skills/skill-provider-destinations.ts`: Orca-owned provider registry.
- `src/main/skills/skill-install-planner.ts`: current-state inspection and conflict decisions.
- `src/main/skills/skill-install-transaction.ts`: locking, staging, commit journal, rollback, and
  recovery.
- `src/main/skills/skill-placement-reconciliation.ts`: aliases, junctions, and verified copy
  fallback.
- `src/main/skills/skill-install-provenance.ts`: bounded receipts and recovery data.
- `src/main/skills/skill-install-service.ts`: orchestration and structured results.

Reuse `observeSkillPackage` and the existing topology/freshness logic directly. Reuse the design
of plugin staging, provenance, lock serialization, and Windows rename retries, but do not import
plugin-domain modules into the skill domain. Promote a primitive only when both domains can name
and test the same contract accurately.

### Cloud client

- Skill upload grant creation and finalization.
- Authenticated share creation and revocation; anonymous share resolution.
- Download grant creation.
- Owned-package management and exact package/version lookup by ID; no browse or search API.
- Authenticated owner-only active-link inventory for cross-device copy and revocation; no public or
  recipient inventory.
- Manager-only package details include ownership and active, unexpired share records; anonymous
  recipients never receive management metadata.

Exact files follow the repository that owns Orca Cloud APIs; desktop contracts stay provider
neutral.

### Runtime and IPC

- Extend the existing skill RPC registration with preview/install/update/remove methods.
- Register the same operations through desktop IPC.
- Route every request to the runtime that owns the selected machine and workspace.
- Keep package transfer separate from installation so direct download and chunked relay converge
  on one staged file.

### Renderer

- Multi-select bundle share review and unlisted-link warning.
- Share completion dialog with copyable durable link.
- Active-link copy/revocation, immutable-version deletion, and Cloud-package deletion with explicit
  confirmation and copy explaining that installed copies remain local.
- Settings → Share Skills owner inventory so newly published links remain manageable even when the
  source skill has no managed-install receipt.
- Selective install preview with destination, scope, coverage, and per-skill conflict state.
- Aggregate install progress and grouped per-skill outcomes.
- Installed/shared bundle management, update, rollback, removal, and incomplete-coverage actions on
  the Skills page.

## Install request and result contract

Conceptual request:

```ts
type SkillBundleInstallRequest = {
  operationId: string
  package: {
    packageId: string
    versionId: string
    bundleDigest: string
    compressedBytes: number
  }
  selectedSkillIds: string[]
  ingress:
    | { kind: 'download-grant'; url: string; expiresAt: string }
    | { kind: 'staged-upload'; uploadId: string }
    | { kind: 'local-file'; path: string }
  destination:
    | { scope: 'global'; environmentId?: string }
    | { scope: 'workspace'; worktreeId?: string; folderWorkspaceId?: string }
  conflictResolutions?: Record<
    string,
    'keep-local' | 'replace-unmodified' | 'replace-and-discard-local'
  >
}
```

`local-file.path` is accepted only across an in-process trusted boundary. It is not exposed as an
arbitrary remote RPC path.

Conceptual result:

```ts
type SkillBundleInstallResult = {
  operationId: string
  packageId: string
  versionId: string
  bundleDigest: string
  status: 'complete' | 'partial' | 'failed'
  skills: Array<{
    skillId: string
    name: string
    status: 'installed' | 'updated' | 'unchanged' | 'kept-local' | 'failed'
    canonicalPath?: string
    placements: Array<{
      provider: string
      path: string
      topology: 'canonical-copy' | 'provider-alias' | 'independent-copy'
      status: 'installed' | 'unchanged' | 'skipped' | 'failed'
      errorCategory?: string
    }>
    conflict?: {
      kind: 'modified' | 'unowned' | 'external-link' | 'name-collision'
      existingDigest?: string
    }
    errorCategory?: string
  }>
}
```

The response never includes a download grant or credentials.

## Installation algorithm

### 1. Admission

- Validate all request fields, package identifiers, selected skill IDs, and per-skill decisions.
- Resolve the destination through host-owned runtime state.
- Confirm the requested scope is writable and contained in an allowed home or workspace root.
- Reject an expired grant before network access.
- Deduplicate retries using `operationId`, package/version, selected skill set, and destination.

### 2. Lock

- Acquire locks for selected canonical destinations in deterministic skill-name order.
- Use an atomic lock-directory or exclusive-file creation supported on all target platforms.
- Record a random owner token and start time.
- Recover a stale lock only after validating its journal and owner liveness policy.
- Bound lock wait time and return a retryable busy result.

An in-process promise chain alone is insufficient because the desktop, headless runtime, CLI, or
SSH helper may run concurrently.

### 3. Ingress

- Stream the archive into a bounded temporary file.
- For grants, require HTTPS when the configured cloud endpoint is HTTPS and restrict redirects and
  final hosts to approved Orca storage origins.
- Abort when compressed bytes exceed the manifest contract.
- Hash while streaming and compare the archive identity supplied by Cloud.
- Delete partial bytes on cancellation, expiration, disconnect, or failure.

### 4. Extract and inspect

- Create extraction staging on the same filesystem as the canonical destination.
- Reject absolute paths, `..`, drive prefixes, NUL bytes, links, devices, FIFOs, sockets,
  encrypted entries, duplicate normalized paths, and case-fold collisions.
- Enforce compressed, extracted, entry, file, depth, and per-file limits during extraction.
- Validate `manifest.json` before trusting file metadata.
- Observe `skill/` with `observeSkillPackage` and compare every file and the package digest.
- Parse `SKILL.md` and require its identity to agree with the package name.

### 5. Inspect current state

Classify the canonical destination and all requested provider placements.

Canonical outcomes:

- Missing: install is allowed.
- Same requested digest: no-op; continue to placement repair.
- Matches Orca receipt and remains unmodified: update is allowed.
- Differs from its Orca receipt: return a modified conflict.
- Exists without Orca provenance: return an unowned conflict.
- External or broken link: return a topology conflict.

Provider outcomes:

- Correct alias or matching Orca-owned fallback copy: no-op.
- Missing: create after canonical commit.
- Broken Orca-owned alias: repair.
- Unowned or modified placement: leave untouched and report incomplete coverage unless the user
  explicitly chooses replacement.

The preview and final install repeat current-state inspection. A state change between preview and
commit invalidates the preview and requires a new decision.

### 6. Prepare commit

- Copy extracted `skill/` into a hidden sibling staging directory.
- Preserve executable modes.
- Observe the copy and require the expected digest again.
- Write a durable transaction journal before moving the current destination.
- Keep the replacement and backup on the destination filesystem so directory renames do not cross
  volumes.

### 7. Commit canonical copy

- If an existing destination is approved for replacement, rename it to the journal's backup path.
- Rename the verified staging directory into the canonical path.
- Use bounded Windows retry behavior for antivirus/indexer `EPERM`, `EACCES`, and `EBUSY` races.
- Observe the installed path and require the requested digest.
- On failure, restore the backup and retain enough journal state for startup recovery.

Directory replacement is crash-recoverable rather than assumed to be a single atomic overwrite on
every platform.

### 8. Reconcile provider placements

- Create aliases relative to their real parent directory on POSIX.
- Use directory junctions with absolute targets on Windows.
- Detect parent directories that are already symlinked to canonical storage.
- If an alias mechanism fails, create and verify an independent copy when policy allows.
- Reconcile each placement idempotently.

Canonical success is retained when one provider placement fails. The result is `partial`, and the
UI offers retry. Rolling back a valid universal installation because one optional alias failed
would make recovery less reliable.

### 9. Publish provenance

Write a bounded, versioned receipt outside the installed skill folder containing:

- Package and version IDs.
- Expected package digest.
- Scope and destination identity.
- Canonical path identity.
- Provider placements and topologies.
- Previous version identity for interrupted-update recovery.
- Installation timestamp and Orca host/runtime identity.

Do not store credentials, download URLs, share bearer values, or package contents.

Serialize receipt updates, write them durably through a temporary file and rename, and support
reconstruction from per-install provenance if the aggregate index is corrupt.

After the receipt is durable, mark the journal complete and delete transactional backups and
staging bytes.

### 10. Verify and publish result

- Run skill discovery on the destination target.
- Confirm the canonical skill and successful provider placements are observable.
- Return observed status and error categories rather than relying on process exit alone.
- Invalidate renderer skill caches and refresh the Skills page.

## Update behavior

1. Resolve the latest accessible immutable version from Cloud.
2. Compare its digest with the receipt.
3. Observe installed bytes before offering the update.
4. If bytes match the receipt, use the normal installation transaction.
5. If bytes were modified, offer:
   - Keep local version.
   - Publish local bytes as a new immutable version when exactly one non-missing Orca-managed
     install matches the skill name and scope; Cloud rechecks ownership of that stable package ID.
   - Replace and discard local changes after explicit confirmation.
6. Reconcile all recorded aliases and fallback copies.
7. Preserve the previous package version in Cloud; rollback is a normal install of that immutable
   version.

Do not invoke `npx skills update` for Orca-owned packages or write entries that cause the community
CLI to claim ownership of them.

## Removal behavior

1. Read Orca provenance and observe every recorded placement.
2. Remove only aliases that still point to the recorded canonical path.
3. Remove independent copies only when their bytes still match their recorded digest, unless the
   user explicitly confirms discarding modifications.
4. Remove the canonical copy only when it is Orca-owned, unmodified, and no retained placement or
   receipt depends on it.
5. Publish the provenance change durably.
6. Leave an unowned or changed destination untouched and report what remains.

Cloud package deletion and local removal are separate actions. Revoking a share prevents new
downloads but does not silently delete already installed local files.

## Remote, SSH, and mixed-version compatibility

Add a static runtime capability:

```text
skills.install.v1
```

Clients check it before sending installation RPCs. Older servers continue supporting discovery
but do not show remote install actions. A missing capability produces an update-required message.

Adding new RPC methods and a static capability does not require a runtime protocol bump. New
fields remain optional until all supported peers understand them. No new terminal stream opcode is
needed.

Recommended RPC surface:

- `skills.install.preview`
- `skills.install.beginUpload`
- `skills.install.uploadChunk`
- `skills.install.commitUpload`
- `skills.install.cancelUpload`
- `skills.install.execute`
- `skills.install.update`
- `skills.install.remove`

Upload sessions are bounded by count, bytes, idle lifetime, and chunk size. Offsets are monotonic;
retries either repeat an acknowledged chunk idempotently or restart the upload. Disconnect and
cancellation release staging bytes. Installation RPC retries are also bounded. Because operation
IDs make commit idempotent, a direct install can converge after its response is lost; a staged
install rebuilds the upload before retrying because the first host attempt may already have
consumed it.

Client cancellation is carried through the local runtime-call queue and every paired request
transport. A queued call is removed before it starts; an in-flight one-shot request closes only its
socket; cached and shared-control requests release only their own request state so unrelated users
of the connection continue. Late responses for cancelled shared requests are retired and ignored.
This is local transport behavior and does not change the mixed-version wire contract; the existing
operation-ID cancellation RPC remains responsible for converging host-side installation work.

SSH Relay errors retain JSON-RPC numeric codes on the wire. Known skill failures add optional,
schema-validated `error.data`; arbitrary handler data is never published. This is additive for
mixed versions and gives SSH the same stable error categories as native and paired installation
without exposing package contents or credentials.

The runtime that executes installation owns:

- Home and config-directory resolution.
- Workspace/folder identity resolution.
- WSL distro selection.
- Agent detection and provider paths.
- Filesystem mutation and recovery.

The calling client owns:

- User authentication and share authorization.
- Destination selection.
- Obtaining a grant or providing package chunks.
- Rendering preview, progress, conflicts, and results.

## Security and privacy controls

The detailed threat register and residual release gates live in
[`docs/reference/agent-skill-sharing-threat-model.md`](./reference/agent-skill-sharing-threat-model.md).

- Treat `SKILL.md` and packaged scripts as executable code for trust messaging.
- Show version, digest, file summary, and executable files before install without exposing internal
  publisher or organization identifiers.
- Require the exact active bearer share ID for recipient resolution and every download grant;
  require authentication for publication and owner management.
- Bind grants to one package version, digest, maximum byte count, and short expiration.
- Validate grant and redirect hosts to prevent server-side request forgery.
- Never execute package scripts during installation.
- Reject links and special files before they can be published or extracted.
- Keep package staging owner-only where platform permissions support it.
- Avoid logging file contents, share tokens, signed URLs, or organization-private names.
- Audit authorization and lifecycle events without storing skill contents in telemetry.
- Apply organization deletion and retention policy to metadata and blobs.
- Rate-limit uploads, downloads, share resolution, and remote transfer sessions.
- Use constant-shape authorization failures so private package existence is not disclosed.

## Failure and recovery model

The transaction journal records enough state to classify interrupted operations:

- Download only: delete partial archive.
- Extracted but not committed: delete staging.
- Existing destination moved to backup: restore backup.
- New destination placed but receipt absent: verify new digest, then either finish receipt
  publication or restore backup according to journal state.
- Receipt published but journal incomplete: verify receipt and installed digest, then finalize.
- Alias reconciliation interrupted: preserve canonical installation and retry reconciliation.

Recovery runs before a new operation for the same destination and during bounded startup cleanup.
It never removes an unknown path based only on a filename pattern; the journal owner token,
destination containment, and expected identities must all agree.

## Testing strategy

### Package tests

- Deterministic manifest and digest generation.
- Source changes during packaging.
- CRLF/LF identity behavior.
- Executable mode preservation.
- Missing or malformed `SKILL.md`.
- Excessive depth, entries, files, individual size, total size, and compressed size.
- Traversal, absolute paths, Windows drive paths, Unicode/case collisions, duplicate paths,
  symlinks, hardlinks, devices, FIFOs, sockets, and encrypted entries.
- Truncated and checksum-invalid archives.
- Invalid gzip bytes with a stable non-retryable archive failure.

### Transaction tests

- Fresh install, identical reinstall, clean update, and explicit replacement.
- Modified and unowned conflicts.
- Existing canonical or provider paths that are files, directories, links, or broken links.
- Failure before and after every journal transition.
- Backup restoration and idempotent recovery.
- Concurrent desktop, runtime, and CLI attempts.
- Cancellation during download, extraction, copy, commit, and alias reconciliation.
- Antivirus-style Windows rename contention.
- Permission failures and read-only destinations.
- Permission and disk-capacity failure injection that preserves the prior installed version.
- Alias failure with verified copy fallback.
- Independent copy drift during update and removal.
- Lost final-response retry for direct installs and staged-transfer rebuild before retry.

### Target matrix

- macOS ARM64 and x64 behavior where available.
- Linux at the supported Ubuntu 20.04/glibc 2.31 floor.
- Windows with junction success, junction denial, copy fallback, and long paths.
- WSL with multiple distros and distro-owned home resolution.
- Local Git worktree and plain folder workspace.
- Paired remote runtimes in both client-newer and server-newer combinations.
- SSH-only macOS/Linux/Windows targets where supported by existing providers.
- Remote target with no outbound Cloud connectivity using chunked transfer.

### Cloud tests

- Anonymous active-link resolution, expiry, revocation, and non-disclosing missing-link failures.
- Owner authentication for package and share management.
- Upload finalization digest mismatch.
- Blob deduplication without cross-tenant information leakage.
- Quota and rate-limit behavior.
- Durable share resolving to the intended immutable version.
- Version update and rollback.

### End-to-end journeys

1. Share on machine A, install globally on machine B, launch a detected agent, and discover the
   skill.
2. Share on machine A, install into a folder workspace on a connected remote runtime, and discover
   it only in that workspace.
3. Modify the installed copy, publish an update, and prove Orca refuses silent replacement.
4. Disconnect during commit, reconnect, recover, and obtain either the complete old or complete
   new version.
5. Revoke a share, prove new installation fails, and prove an existing local installation remains.

## Observability

Record bounded operational metrics:

- Package byte/file counts and stage durations.
- Download versus client-mediated transfer selection.
- Install outcomes by category.
- Conflict categories.
- Alias, junction, and copy-fallback rates.
- Recovery and rollback counts.
- Runtime capability absence.
- Error categories by operating system and target kind.

Do not record skill contents, file names beyond approved aggregate categories, private share URLs,
download grants, access lists, or raw local paths.

User-facing logs show phase, destination label, placement outcome, and actionable error. Sensitive
network values are redacted at creation rather than scrubbed after logging.

## Delivery phases

### Phase 0: contracts and vertical spike

Deliver:

- Package manifest schema.
- Local package builder and bounded extractor.
- A programmatic install call from a validated staging directory into a temporary canonical root.
- Fresh install and modified-conflict tests on macOS, Linux, and Windows CI.
- Decision record confirming upstream is behavioral-reference-only and no material is copied.

Exit criteria:

- No `npx` or Node installation dependency outside Orca's own runtime.
- Same bytes produce the same digest on every target platform.
- Invalid archive classes fail before destination mutation.

Estimate: 2–3 engineer-days for the spike, followed by design review.

### Phase 1: production local installer

Deliver:

- Cross-process lock.
- Durable journal and recovery.
- Canonical install, update, and removal.
- Provenance receipts and aggregate index recovery.
- Provider registry for Orca's primary detected agents.
- POSIX aliases, Windows junctions, and verified copy fallback.
- Structured preview/result contracts.
- CLI-only developer harness for deterministic integration tests.

Exit criteria:

- Failure injection at every commit boundary preserves either the previous or requested complete
  package.
- Local modifications are never silently replaced.
- Folder workspaces and global scope pass the platform matrix.

Estimate: 5–8 engineer-days.

### Phase 2: private Cloud sharing

Deliver:

- Reviewed Terraform for the dedicated private GCS bucket, lifecycle, CORS, bucket-scoped IAM,
  service-account signing, `orca_skills` database, database secret, Cloud SQL attachment,
  monitoring, and budgets.
- PostgreSQL migrations for package, version, upload, share, ownership, and audit records, with
  legacy ACL storage tolerated during migration.
- Upload/finalize APIs using bounded V4 signed POST policies and private content-addressed GCS
  objects.
- Version, bearer-share, revocation, five-minute download grant, quota, and audit behavior.
- Share preview and owner-management UI.
- Install preview and local-machine installation UI.
- Durable links and short-lived grants.
- Update availability and version rollback.

Exit criteria:

- A copied active durable link can be inspected and installed without recipient sign-in.
- Revocation immediately blocks new grants.
- The installed receipt identifies the immutable package without persisting a grant.
- Production provisioning changes are Terraform-owned and do not replace existing artifact,
  Cloud SQL, or Cloud Run resources.

Estimate: 1–2 engineer-weeks across desktop and Cloud work.

### Phase 3: paired Orca runtime installation

Deliver:

- `skills.install.v1` capability.
- Runtime preview/install/update/remove methods.
- Direct runtime download.
- Bounded client-mediated upload fallback.
- Destination-machine and remote-workspace selection.
- Mixed-version UI and compatibility tests.

Exit criteria:

- Installation executes on the selected host and uses that host's home, workspace, and detected
  agents.
- Older hosts are not called and receive a clear update-required state.
- A host without outbound internet installs through the authenticated chunked transfer path.

Estimate: 4–7 engineer-days.

### Phase 4: WSL and SSH completion

Deliver:

- Distro-owned package ingress and installer execution.
- SSH package upload and host-side structured installer invocation.
- Cross-target cancellation and cleanup.
- WSL/SSH provider detection and path coverage.
- Real-host end-to-end coverage.

Exit criteria:

- No desktop path is substituted for a WSL, SSH, or runtime path.
- SSH and WSL return the same result contract as native installation.
- Failure and cancellation leave no untracked staging bytes outside bounded recovery retention.

Estimate: 4–7 engineer-days, depending on host-helper availability.

### Phase 5: multi-machine management and reconciliation

Deliver:

- “Install on another machine” and multi-machine progress.
- Optional desired-version policy for selected personal or organization machines.
- Drift and missing-install reconciliation.
- Explicit project desired-state manifest if validated by product usage.
- Direct machine-to-machine transfer as an alternative to Cloud persistence if required.

Exit criteria:

- Reconciliation remains opt-in and never overwrites local modifications.
- Offline machines converge after reconnect without sharing durable credentials.
- Organization removal, user departure, and package retention have documented semantics.

Estimate: separate product milestone after first-release usage data.

## Release gates

Before enabling Cloud or remote installation by default:

- Threat-model review covers package ingestion, grants, SSRF, archive extraction, local path
  containment, and instruction/script trust.
- Cross-platform CI covers the package and transaction suites.
- Real Windows validates junction and copy fallback.
- Real WSL and SSH validate host-owned paths.
- Mixed-version remote tests cover old client/new server and new client/old server.
- Download/upload cancellation and app/runtime crash recovery are exercised.
- Telemetry and diagnostic bundles are verified not to contain grants or private contents.
- Share deletion, revocation, organization departure, and retention behavior are documented.
- The UI identifies the author and executable content before installation.
- A kill switch can disable new Cloud grants and remote installs without affecting discovery or
  already installed skills.

## Effort summary

For one engineer familiar with Orca:

| Scope                               |                                     Estimate |
| ----------------------------------- | -------------------------------------------: |
| Disposable canonical-copy prototype |                                     1–2 days |
| Production local installer          |                                     5–8 days |
| Cloud sharing and local install UX  |                                    1–2 weeks |
| Paired runtime support              |                                     4–7 days |
| WSL and SSH completion              |                                     4–7 days |
| Polished first release              |             Approximately 3–5 engineer-weeks |
| Full community CLI parity           | 6–10 weeks plus ongoing registry maintenance |

The recommended first release ends after Phase 4. Phase 5 should follow observed demand rather
than delaying private sharing for organization-wide policy features.

## Implementation principles

- One validated installer core, regardless of source or destination transport.
- One canonical copy, with provider placements reconciled separately.
- Immutable Cloud versions and mutable local installations are distinct concepts.
- An unpredictable durable share ID is a revocable bearer credential, not a permanent blob URL.
- Installed bytes, not child-process exit codes, determine success.
- Unknown or modified local state fails closed.
- Remote hosts own their paths and mutations.
- Upstream behavior informs compatibility but does not define Orca's internal architecture.
