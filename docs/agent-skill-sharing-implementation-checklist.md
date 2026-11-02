# Agent skill sharing implementation checklist

Status: implementation and validation in progress.

Last updated: 2026-08-12.

Implementation baselines captured by this checklist update:

- Orca implementation: `skills-share` through `607e31dd04`; no PR.
- Orca Cloud: bundle smoke PR `#329` merged as `eddb144afe`; generation-aware recovery PR `#330`
  merged as `8045c85dad`; encrypted physical-host credential PR `#336` merged as `8fce3298ef`;
  kill-switch discovery PR `#342` merged as `c2bef2ff20fb`.
  Windows device-name validation PR `#343` merged as `dbb14a658cbc`; explicit disabled production
  bootstrap PR `#352` merged as `2a23f6ace5`; publisher-identity omission PR `#355` merged as
  `b3213bd34d1b224d8a3b11527eceaac883965400`; production enablement PR `#357`, bounded OIDC smoke
  PR `#358`, monitor IAM PR `#359`, and monitor release-ownership PRs `#360`/`#361` are merged
  through `d8605edde72229c5d00d22c8bd6853a13c1a4aaa`.

Validated so far:

- Current release hardening cancels bundle extraction after partial bytes exist and removes the
  extraction directory, durable journal, and managed-install state. Four repeated focused runs and
  the real SIGKILL recovery test passed. Signed GCS uploads use the earlier of signed-policy expiry
  and a 15-minute cap, including their archive read stream, so slow valid uploads can finish while
  stalled uploads remain bounded.
- Local and headless managed-skill operations now wait for the one startup transaction-recovery
  promise before reading or changing install state. Codex uses its documented global
  `~/.agents/skills` root, and provider removal derives allowed roots from the registry so aliases
  remain removable after an agent is no longer detected. The combined focused suite passed 74
  tests across 12 files, including fake-timer slow-upload and controlled-recovery regressions.
- The reported desktop install failure was a strict main-process IPC schema rejecting the
  renderer's additive `providers` selection before bundle verification. All four install schemas
  now accept the bounded field, and focused schema/provider tests pass. The original production
  link resolves as a valid one-skill bundle and returns a fresh same-version local download grant;
  the signed URL and private metadata were not logged or printed during verification.
- The final reliability hardening at `607e31dd04` adds a 60-second Cloud request deadline;
  cancellable, journaled bundle extraction; bounded package creation, verification, and preview
  fanout; atomic share-preparation admission and abandoned-archive cleanup; process-owned download
  staging; SSH startup recovery; and additive paired-client cancellation-result negotiation. The
  focused suite passed 78 ordinary tests plus a real process-death recovery test. Full Node, CLI,
  and web typechecks, repository lint and reliability gates, changed-file formatting, and diff
  checks passed. Mobile-facing wire changes remain additive, and no mobile app surface changed.
- A final performance and React lifecycle review found one stale-response race in managed-install
  inventory: a slower previous machine could overwrite the newly selected machine's list. The
  generation fence and regression test now preserve destination ownership; bundle busy state also
  reaches the parent close guard in the initiating event instead of a mirror effect. The complete
  renderer skill/settings slice passed 122 tests across 18 files, all Node/CLI/web typechecks,
  focused Oxlint, changed-code quality, max-lines, diff, and localization gates.
- The final local readiness pass at `9fcd72e327` passed 489 skill-domain tests across 73 files
  with 11 intentional platform skips, all Node/CLI/web typechecks, localization catalog,
  extraction and coverage, max-lines, changed-code quality, React Doctor, formatting, and diff
  checks. No new P0, P1, or P2 finding was proven by the crash/retry, security, performance,
  functional, mobile-backcompat, or Windows/Linux review.
- Multi-select sharing now preserves hidden selections, reconciles changed discovery scans,
  visibly explains ineligible skills, and blocks duplicate names before review. Exact complete
  managed bundles publish a new immutable version to their existing package; ambiguous or partial
  selections safely create a new package. Managed bundles with an active link can reopen the
  destination-aware installer for another machine; the final renderer slice passed 114 tests.
- The mobile/backcompat review found no persisted mobile keys, routes, deep links, or required
  legacy fields changed. Skill RPC methods and capabilities are additive and capability-gated;
  the cross-platform review found production paths use host path APIs and platform checks, with
  POSIX-only literals confined to tests or WSL guest execution.
- Final bearer-link changes pass 143 Orca Cloud API tests with one opt-in skip; 58 focused Orca
  tests; four mixed-version wire tests; desktop/node/web typecheck; localization catalog,
  extraction, and coverage; changed-code quality; max-lines; and diff checks.
- The final Cloud change passed PR run `31564069382` and merged-`main` run `31564235724`, including
  the full monorepo build, lint, typecheck, tests, Terraform format, and Terraform validation.
- The opt-in desktop staging harness now publishes a bearer share without retired audience fields;
  Node typecheck and Playwright test discovery pass without starting Orca or a browser login flow.
- Local Node and web typechecks, changed-code quality gates, 94 skill-domain files with 770 tests
  passed and 3 skipped, 134 Orca Cloud API tests with one opt-in integration skip, the full Cloud
  monorepo test/typecheck/lint/build gates, and isolated Terraform formatting and validation.
- Final Orca validation passed repository-wide lint, all Node/CLI/web typechecks, the production
  desktop/native build, the Node 18 Relay bundle contract, 78 focused skill files with 557 tests
  passed and 10 platform skips, and the mixed-version wire suite. The full repository run passed
  49,977 tests with 112 skips; its three environment/timeout failures passed as a 124-test rerun
  after removing Orca-injected Git config variables and rerunning the slow macOS PTY case.
- Skill sharing and installation renderer copy now passes the localization catalog, extraction,
  and coverage gates without a max-lines exception.
- Remote upload sessions actively expire abandoned bytes after their bounded idle lifetime, and
  begin/chunk/commit retries resume from the host-acknowledged offset under one stable transfer ID.
- Paired skill install and upload cancellation now reaches queued calls, capability probes,
  one-shot sockets, cached request sockets, and shared-control requests instead of waiting for the
  five-minute transfer timeout. Focused coverage proves queued work never starts, pending request
  admission is released, late responses are ignored, one-shot sockets close, and unrelated cached
  or shared-control requests survive; 84 transport/service tests and Node typecheck passed.
- Standalone and bundled package names reject Windows reserved device names in both Orca and Cloud,
  preventing a package published on macOS/Linux from failing only when installed on Windows.
- Identical archives are deduplicated only within an owner tenant. PostgreSQL object identity and
  tenant-hashed GCS keys prevent cross-tenant existence or finalization-timing disclosure.
- Native Windows package/install/recovery/copy-fallback tests and Node typecheck on `windows 2`;
  the current slice passed 284 tests with 21 intentional platform skips across 43 files.
- The final combined physical `windows 2` run at `44d1266641` enabled native-Windows, real-process,
  and Ubuntu 24.04 WSL coverage together: 67 files passed, 449 tests passed, and 17 intentional
  platform skips remained. Commit `97b831dd17` made Windows recovery assertions path-semantic and
  time-deterministic. Commit `44d1266641` fixed WSL alias reconciliation after proving native UNC
  `lstat` can miss an existing distro symlink; WSL now inspects the alias in-distro and creates new
  aliases with `ln -sT`. The checkout remained clean and no `orca-skill-*` directory remained in
  WSL `/tmp`.
- Native Windows transaction validation passed all 21 cases at `6d3ce582aa`, including a real
  canonical install beyond `MAX_PATH` while the host's `LongPathsEnabled` policy remained disabled.
- Real Ubuntu 24.04 WSL global, guest-workspace, and `/mnt/c` workspace transactions, including
  alias placement, interrupted update recovery, conflict preservation, update, and removal.
- Real Ubuntu 24.04 WSL provider detection and POSIX semantics, including case-sensitive names,
  `0600` regular files, and `0700` executable files.
- Exact portable package digest and archive SHA-256 goldens passed on macOS and native Windows
  despite different bundled zlib versions (`1.2.12` and `1.3.1`).
- The focused deterministic package suite passed 26/26 tests in Debian Bullseye/glibc 2.31 on
  native Linux ARM64 and emulated Linux x64, plus the real Ubuntu 24.04 WSL distro on `windows 2`;
  every host produced the same package digest and archive SHA-256 golden.
- The same 26/26 portable package suite passed at `109272dab1` on a disposable native x86_64
  Ubuntu 22.04 GCE host using Linux 6.8 and Node 24.18. The VM had no service account or scopes;
  its boot disk, uploaded Git bundle, and temporary project SSH metadata were removed afterward.
- The exact x64 Electron directory package at `f1dccb4f42` passed its after-pack ABI scan for all
  18 bundled native binaries, then loaded packaged `node-pty` and spawned `/bin/sh` inside an
  Ubuntu 20.04/glibc 2.31 container. The physical run corrected the gate to use Linux's actual
  `orca-ide` executable and `resources/node_modules` layout. A native ARM64 package built from
  exact commit `abe92d565b` on an isolated `aarch64` GCE host then passed the same 18-binary
  Ubuntu 20.04/glibc 2.31 ABI gate and packaged `node-pty` load/spawn smoke. The ARM64 VM had no
  service account or scopes; its auto-delete boot disk was verified absent, and its local Git
  bundle was moved to Trash after the clean-checkout proof.
- Real native Windows global, linked Git-worktree, and plain folder installs with spaces and
  non-ASCII paths, plus privacy-safe install diagnostics and owner-private staging tests.
- Docker-backed SSH relay installation from the real Electron client passed global, remote Git
  worktree, and remote plain-folder scopes, including client-mediated upload, unchanged preview,
  managed-install listing, safe removal, and remote-target Cloud authorization.
- Real paired-runtime installation passed from an isolated Electron client to both a headed
  desktop host and headless `orca serve` host. The host owned global and Git-worktree installs;
  the headed host also owned a plain-folder install. The client's home remained untouched.
- A fresh post-resilience E2E run passed all three headed paired-runtime, headless `orca serve`,
  and Docker SSH journeys. Focused failure injection also proves invalid gzip classification,
  old-version preservation after `EACCES` and `ENOSPC`, bounded recovery from a lost final install
  response, and validated structured SSH failure data without arbitrary error-data disclosure.
- Isolated staging bucket, IAM, `orca_skills` database and principal, enabled secret version, 11
  log metrics, four alerts, and one dashboard in `onorca-cloud-staging`. The complete targeted
  skill-infrastructure plan is zero-diff at Cloud `41ef335`.
- PostgreSQL migration startup is serialized by a transaction-scoped advisory lock. Transactional
  DDL rollback and eight concurrent startup callers passed against ephemeral PostgreSQL 16 and 17,
  with exactly one recorded schema version.
- Cloud PR `#349` merged as `6a812c5e11` after proving an older API migration runner preserves a
  newer additive column/table and continues using its existing SQL. Build, lint, typecheck, tests,
  Terraform initialization, and validation passed; no service or infrastructure was deployed.
- Cloud PR `#350` merged as `c22007384a` and added a required disposable PostgreSQL 16/17 drill.
  Real old and future-additive Node processes coexist and write against one database, the database
  is dumped and restored, and both processes write again after restoration. PR run `31624484826`
  and merged-main run `31624717796` passed every code, Terraform, and database job; no staging or
  production resource was accessed or deployed.
- The immutable API deploy path stamps every artifact and skill literal variable plus exactly one
  approved skill-database secret, and rejects secret, Cloud SQL, service-account, scaling, CPU,
  memory, volume, mount, probe, or unexpected-environment drift before traffic promotion.
  Staging intentionally carries all four skill controls as `true`; production remains `false`.
- The route-disabled baseline, API revision `orca-cloud-api-staging-00039-rek`, first proved the
  database-ready startup and anonymous `401`/`404` boundaries with zero revision errors.
- Cloud PR `#313` passed run `31533988351`, merged as `d0bf926`, and passed `main` run
  `31534229437`. Guarded wake run `31534564230` restored exactly the two configured Relay cells.
- Auth deploy run `31535179937` promoted revision `orca-cloud-auth-staging-00017-dug` at 100%
  traffic. Health, JWKS, exact GitHub OIDC claim constraints, and zero deployment-window errors
  passed.
- The historical ACL-era API deploy run `31535438327` promoted revision
  `orca-cloud-api-staging-00042-hef` at 100%
  traffic with `authenticatedSmoke: true` and `skillSmoke: true`. The smoke covered artifact
  lifecycle; skill upload/finalize/download; two immutable versions; recipient and outsider
  authorization; local and remote grants; rollback selection; expiry; revocation; package
  deletion; and signed-object cleanup.
- Cloud PR `#317` passed both required checks and merged as `be00db10`. Its historical ACL-era
  deploy run `31546194596`
  promoted revision `orca-cloud-api-staging-00048-xom` at 100% traffic with
  `authenticatedSmoke: true` and `skillSmoke: true`; canonical health and the immutable image
  digest independently matched after promotion.
- The signed-in macOS desktop staging journey reached upload, finalize, durable share creation,
  and global install after replacing an invalid colon in the audience-derived idempotency key.
  The retry test now requires a stable path-safe key, and the live test records the package ID
  before publication so a failed share can still clean up its finalized package. Its update phase
  uncovered same-name discovery ambiguity; the harness now selects the exact workspace source
  directory instead of the first same-named global skill. A final full live rerun remains open.
- The serving API has all four controls `true`, zero revision errors, and privacy-safe structured
  request logs. The log field inventory contains no principals, credentials, signed URLs, object
  paths, or private contents; a sensitive-value scan returned zero matches.
- Cloud PR `#314` removed deploy-owned Auth release metadata from Terraform ownership, passed run
  `31536141357`, merged as `4e91cf9`, and passed `main` run `31536329459`. The targeted Auth/API
  plan then reported zero intended changes. Known SQL and artifact-bucket drift was excluded and
  never applied.
- Cloud PR `#320` passed both required checks and merged as `0579cc1a71`. Targeted Terraform added
  only `google_logging_project_exclusion.skill_share_bearer_request_urls` in staging: one addition,
  zero changes, and zero deletions. This prevents per-link Cloud Run request URLs from entering
  log storage while retaining route-template application telemetry.
- Guarded wake run `31564370807` prepared the reviewed staging topology. Deploy run `31564803943`
  promoted `orca-cloud-api-staging-00051-yoq` at 100% traffic with immutable image digest
  `sha256:511c0196511d2079bd9138092ad3cf065304b46a089b02d8df9318e0ae2e656a` and reported
  `authenticatedSmoke: true` and `skillSmoke: true`.
- Candidate and canonical smoke produced 60 privacy-safe route-template events covering owner
  upload/finalize/share creation/inventory/revocation and anonymous pinned/latest preview,
  local/remote download grants, version selection, expiry, uniform unavailable responses,
  package deletion, and object cleanup. Anonymous requests with no Authorization header and an
  invalid header both returned the same `404 skill_share_not_found` response with `no-store`.
  The serving revision had zero error logs and Cloud Logging retained zero per-link platform
  request logs.
- Guarded sleep run `31546908228` stopped all three Relay cells after the physical staging work.
  Independent GCP reads verified Cloud SQL policy `NEVER`, every MIG target at zero, and both
  managed Cloud Run minimums at zero.
- Final guarded sleep run `31565009141` restored the same low-cost state after the bearer rollout;
  independent reads found Cloud SQL `NEVER`/`STOPPED` and C1, C2, and C3 at target size zero.
- Cloud PR `#329` passed required checks, merged as `eddb144afe`, and passed merged-main run
  `31569732482`. Browser-free desktop run `31569902499` then passed bundle publish v1, install,
  local modification preservation, v2 update, rollback, revoke, installed-copy preservation, local
  removal, and Cloud package deletion without opening a login page.
- Cloud PR `#330` passed required run `31578720429`, merged as `8045c85dad`, and passed merged-main
  run `31578942857`. Guarded wake `31579195133` brought SQL and all three Terraform-owned cells up;
  deploy `31579844413` promoted `orca-cloud-api-staging-00057-kat` at 100% traffic with immutable
  digest `sha256:f61745b21d00b111087620ab1108c9a96e9863ec9e902a424aaad01e9e945605`.
- Recovery smoke `31580071168` published an isolated bundle, soft-deleted the exact published GCS
  generation, restored it with `ifGenerationMatch=0`, verified immutable metadata, transactionally
  repointed every matching database reference, verified the unlisted bearer download, and deleted
  the probe. No ephemeral recovery job or live probe object remained.
- Guarded sleep `31580339694` returned staging to low cost. Independent reads verified Cloud SQL
  `NEVER`/`STOPPED`, C1/C2/C3 target size zero and stable, and API/Auth min scale zero. Production
  was not touched.
- Cloud PRs `#332` through `#335` added the staging-only 12-by-30 finalization load gate, narrowly
  authorized its OIDC identity, fixed deterministic fixture ordering, and made retry settlement
  cleanup-safe. Their merge commits were `ac85d0690e`, `53559bd644`, `7e1d50a84b`, and
  `bb8bf8b9ac`; merged-main verification passed through run `31586525326`.
- Auth deploy `31584318896` promoted `orca-cloud-auth-staging-00021-tuq` with digest
  `sha256:e17075d69dca36df427f02fa515481f359c8f67397c5ab16de9759f7f949c6be`; candidate and
  canonical smoke passed with one 100%-traffic revision and no remaining candidate tag.
- Load run `31585710645` exercised 12 concurrent bundles with 30 skills and 3,949,317 extracted
  bytes each. Two finalized immediately and ten returned explicit saturation; client p95 was
  1,514 ms. Aggregate utilization stayed bounded: request p95 1,401.06 ms, API CPU 8.95%, API
  memory 26.95%, one API instance, database CPU 10.89%, database memory 25.59%, and seven
  connections. A saved, exact one-add Terraform plan restored the declared
  `roles/monitoring.viewer` binding for the staging deploy identity before those aggregate metrics
  were read; it changed no service, traffic, SQL, storage, Relay, or production resource.
- Cleanup run `31586684354` removed the exact failed-wave package set through normal package DELETE
  routes. The two remaining quarantine archives were manifest-proven as 30-skill fixtures for
  suffix `013756ec4740` and deleted with exact GCS generation preconditions; no live object from
  that run window remained. GCS soft delete keeps the operation recoverable.
- Guarded sleep `31587083752` returned staging to low cost. Independent reads verified Cloud SQL
  `NEVER`/`STOPPED`, C1/C2/C3 target size zero and stable with no current actions, and API, Auth,
  and Relay active-revision minimums at zero. Production was not touched.
- Cloud PR `#336` added a browser-free physical-host credential handoff restricted to the exact
  `main`-branch staging workflow identity. It encrypts only the ten-minute owner token to a
  one-time RSA-3072 key, grants no GCP permissions, retains ciphertext for at most one day, and
  passed PR run `31588982191` plus merged-main run `31589194501` as merge `8fce3298ef`.
- Guarded wake `31589384191` restored SQL and the two configured Relay cells without waking C3.
  Auth deploy `31589963244` promoted `orca-cloud-auth-staging-00025-zuz` at 100% traffic with
  immutable digest `sha256:2b5cb04060a871f372298786dbed681054a076f5cf75966ea5e2130403db7254`.
- The physical `windows 2` staging journey passed in 27.6 seconds using credential run
  `31591275227`. It installed v1 into the Windows-owned global path with the published digest and
  no macOS fallback, updated only that host to v2, preserved independent local version selection,
  rolled Windows back to v1, proved revocation left its installed copy intact, removed both host
  and local installs, and deleted the Cloud package. The encrypted artifact and local one-time key
  material were deleted immediately after use.
- The staging skill bucket independently reports the exact age-one-day Delete lifecycle restricted
  to `uploads/`, seven-day soft deletion, uniform bucket access, and public-access prevention. Its
  oldest live quarantine object was created at `2026-08-11T22:49:34Z`, so lifecycle execution—not
  configuration—is still time-gated.
- Guarded sleep `31592709817` completed at Cloud `8fce3298ef`. Independent reads verified SQL
  `NEVER`/`STOPPED`, all three Relay MIGs stable at target zero with no active actions, and API,
  Auth, and Relay active-service minimums at zero.
- Real process-death recovery now kills the transaction process after partial extraction and
  immediately before and after every durable install/removal journal transition. All 17 macOS
  cases passed, including extraction cleanup, dead-lock reclamation, receipt/filesystem agreement,
  and absence of transaction debris; the release workflow requires the same suite on macOS,
  native Windows, and Ubuntu 20.04/glibc 2.31.
- Guarded wake `31603249983` restored only the two configured staging cells. A disposable
  no-service-account Ubuntu 20.04/glibc 2.31 VM then passed the browser-free SSH staging lifecycle
  in 31.3 seconds: publish v1, host-owned install with exact digest, v2 update, managed-install
  verification, rollback, revocation with installed-copy preservation, local removal, and Cloud
  package deletion. The remote install, Orca SSH target, encrypted credential artifact, one-time
  keys, and VM were removed. Guarded sleep `31604391897` passed; independent reads verified SQL
  `NEVER`/`STOPPED` and C1/C2/C3 target zero, stable, and reached. Production was untouched.
- Guarded wake `31634214856` restored the two configured cells at Cloud `dfb8359ff5`. An isolated
  native `Darwin arm64` OpenSSH target with a separate temporary home then passed the full staging
  lifecycle in 20.1 seconds: publish v1, SSH-owned install, v2 update, managed-version checks,
  rollback, revocation with installed-copy preservation, removal, and Cloud package deletion.
  This corrected the staging oracle to accept absolute POSIX homes outside `/home`. The GitHub
  ciphertext artifact was deleted immediately; the SSH service, relay, install, temporary home,
  and one-time keys were removed. Guarded sleep `31635145830` passed; independent reads verified
  SQL `NEVER`/`STOPPED`, all three MIGs stable and reached at zero with no active actions, and
  API/Auth/Relay minimum scale zero. Production was untouched.
- Guarded wake `31605729090` restored the same configured topology. An isolated headless Orca host
  with a separate home/profile then passed the full paired-runtime staging lifecycle in 12.5
  seconds, proving host-owned install, update, managed-install state, rollback, revocation
  preservation, removal, and Cloud deletion without local fallback. The paired environment,
  install, package, encrypted credential artifact, and one-time keys were removed. Guarded sleep
  `31606600532` passed; independent reads again verified SQL `NEVER`/`STOPPED` and all MIGs at
  stable, reached target zero.
- Guarded wake retry `31630802215` succeeded at Cloud `dfb8359ff5`; the additional physical WSL
  Cloud journey was then waived as duplicate release evidence. The first guarded sleep attempt
  `31631288043` failed closed during Terraform provider initialization on a transient upstream
  `503`, before the mutation step. Retry `31631379891` succeeded. Independent reads verified SQL
  `NEVER`/`STOPPED`, all three MIGs stable and reached at target zero with no active actions, and
  the API, Auth, and Relay active-revision minimums at zero. Production was untouched.
- Cloud PR `#355` removed internal publisher and organization identifiers from anonymous skill
  responses, passed every code, Terraform, and PostgreSQL 16/17 check, and merged as
  `b3213bd34d1b224d8a3b11527eceaac883965400`. Guarded wake `31639920301` prepared staging. Deploy
  `31640677572` promoted `orca-cloud-api-staging-00060-qay` at 100% traffic with immutable digest
  `sha256:31cb0a91a7abf1f82e4de08bd31e98fbd71519adc731a005fc95f60480658f73`; authenticated and skill
  candidate/canonical smoke passed. The unrelated post-promotion storage-monitor image update
  lacked `iam.serviceAccounts.actAs`; the unchanged prior monitor image remains serving, and the
  API promotion and verification completed successfully. Guarded sleep `31640935616` passed in
  8m51s. Independent reads verified SQL `NEVER`/`STOPPED`, C1/C2/C3 stable and reached at target
  zero, and the API at minimum scale zero with revision `00060-qay` retaining 100% traffic.
  Production was untouched.

Rollout gate: staging infrastructure, OIDC owner identity exchange, anonymous bearer lifecycle,
owner management, browser-free desktop bundle lifecycle, privacy-safe logging, published-object
recovery, bounded finalization load, and guarded rollback-capable deployment passed. Production
infrastructure and the unlisted-link API are live with all four controls enabled after successful
authenticated candidate and canonical lifecycle smoke. Native Windows, real Ubuntu 24.04 WSL
filesystems, physical Ubuntu 20.04 and
macOS ARM64 SSH, and paired non-Windows staging passed. On 2026-08-12, the owner accepted the
remaining live WSL-to-staging journey as duplicate evidence after the combined 449-test physical
Windows/WSL run and native-Windows staging lifecycle; this does not treat WSL semantics as
identical to macOS. The user-driven signed-in desktop and real-host production journey, supported
Windows SSH, and the quarantine lifecycle deletion remain. The shared staging data plane is asleep.

This checklist turns the architecture plan into ordered implementation and release work. A checked
item means evidence exists in code, tests, reviewed infrastructure, or release documentation; it
does not mean the surrounding phase is complete.

## Definition of done

- [x] A user can select one or many private local skills, publish one immutable Skill Bundle, and
      receive one durable Orca share URL.
- [x] Anyone with an active unlisted link can inspect a bundle without signing in, choose all or a
      subset of its skills, and install them globally or into a Git worktree or plain folder
      workspace.
- [x] Installation works on local macOS, Linux, native Windows, WSL, paired Orca runtimes, and
      supported SSH targets.
- [x] The portable archive root conforms to Agent Plugins 1.0.0 for skills-only packages and keeps
      Orca integrity metadata in `dev.orca.skill-sharing/manifest.json`.
- [x] One canonical `.agents/skills/<skill-name>` copy is installed for each selected skill;
      provider-specific placements are reconciled for explicitly selected agents, defaulting to
      detected agents when no selection is supplied.
- [x] Install, update, rollback, and removal preserve modified or unowned local content unless the
      user explicitly approves replacement.
- [x] Package ingestion rejects unsafe archives before any destination mutation.
- [x] Interrupted operations recover to a complete previous or requested version.
- [x] Private package bytes remain access-controlled, published versions persist until deletion,
      and incomplete uploads expire automatically.
- [x] Mixed-version clients and remote hosts fail safely through capability negotiation.
- [x] Cloud resources are Terraform-owned, monitored, recoverable, and protected by independent
      upload, download, and remote-install kill switches. Targeted Terraform is zero-diff; staged
      generation recovery passed; dashboards, alerts, and runbooks cover the data plane; and Cloud
      PR `#342` proves all three mutation controls can be disabled independently while unlisted
      preview remains available.
- [x] The existing Skills page supports multi-select sharing, selective installation, per-skill
      conflicts/results, and installed-bundle management; Settings → Share Skills provides the
      authenticated owner inventory for copying and revoking active links.

## 0. Confirm scope and ownership

### Product and legal decisions

- [x] Record `vercel-labs/skills` as a behavioral reference only.
- [x] Record upstream baseline commit `c6f69c631292444cc541ac6d91e2226b0ff247da`.
- [x] Decide not to copy upstream source, tests, fixtures, registry data, or path tables.
- [x] Decide Orca will not depend on the upstream CLI or an unsupported programmatic API.
- [x] Decide V1 accepts Orca package sources only; Git, npm, and community registries remain with
      existing tools.
- [x] Decide every Skill Bundle share is unlisted and reachable only through its durable link; do
      not add search, browsing, organization-library, marketplace, or contained-skill indexes.
- [x] Record Agent Plugins 1.0.0 commit `bd383552095128f6effe895b9257cfd580a6d179`
      as the portable-format reference.
- [x] Decide to implement from the specification without copying its CC BY prose or vendoring its
      Apache-licensed schemas.
- [x] Treat the archive as a Skill Bundle, not an Orca plugin product or executable plugin runtime.
- [x] Limit V1 bundles to skills; exclude MCP servers, hooks, processes, connectors, and
      permissions.
- [ ] Review the architecture decision record covering the reference-only boundary with
      engineering and legal owners.
- [x] Add a review check that flags any proposed copied or mechanically translated upstream
      material so attribution and licensing can be reconsidered before merge.
- [ ] Assign desktop, runtime, Cloud API, Terraform, security, design, and release owners.
- [ ] Confirm the first release ends after WSL and SSH support; keep team reconciliation as a later
      product milestone.

### Product semantics

- [x] Confirm private means unlisted and protected by an unpredictable revocable bearer link, not
      end-to-end encryption from Orca Cloud operators.
- [x] Confirm a published immutable version persists until package or version deletion; it has no
      age-based object expiry.
- [x] Confirm an unfinished upload grant expires after 15 minutes and its quarantine object is
      deleted after one day.
- [x] Confirm a durable share URL contains a bearer credential for a revocable authorization
      record, not a GCS object or permanent blob grant.
- [x] Confirm a signed download grant lasts five minutes and is the maximum share-revocation lag.
- [x] Confirm updates create immutable versions and never mutate existing package objects.
- [x] Confirm rollback installs a selected prior immutable version.
- [x] Confirm revoking or deleting a Cloud share does not silently remove existing local installs.
- [x] Confirm sharing and updating use an artifact-like flow—preview, upload, unlisted durable
      link, update, revoke/delete—while retaining skill-specific version, trust, and install
      semantics.
- [x] Confirm recipients do not sign in; publishing and managing owned links still require sign-in.
- [x] Confirm revocation blocks future resolution/download grants but does not remove installed
      copies.
- [x] Add a Settings section named **Share Skills**, parallel to **Artifacts**, without adding any
      index or discoverability surface.
- [x] Treat the authenticated owner-only active-link inventory as management, not recipient
      discoverability; never expose it anonymously or through browse/search APIs.
- [x] Confirm V1 has no checked-in workspace desired-state lockfile and no automatic fleet-wide
      installation.
- [x] Confirm one skill is a one-item bundle and a bundle may contain large selections such as 30
      skills behind one durable link.
- [x] Keep bundle identity, access, versions, transport, update/rollback, revocation, and deletion
      at bundle scope.
- [x] Keep installation selection, conflicts, provenance, modification protection, and outcomes at
      skill scope.
- [x] Keep loose-skill installation as the universal/default path and treat provider-native plugin
      adapters as optional compatibility outputs.

### Existing-code and provider research

- [x] Inventory current skill discovery, `observeSkillPackage`, package identity, topology, and
      freshness code; record reusable contracts and missing behavior.
- [x] Inventory plugin staging, provenance, lock serialization, and Windows rename retry designs;
      extract only primitives that both domains can name and test accurately.
- [x] Inventory current desktop IPC and remote skill RPC registration.
- [x] Inventory existing SSH execution and file-transfer providers and identify the host-side
      installer entry point.
- [x] Research official documentation for every initially supported agent's global and project
      skill directories.
- [ ] Verify each provider path with a real installation on every supported platform.
- [x] Record whether each provider reads `.agents/skills` directly, how it is detected, and which
      alias mechanisms it supports.
- [x] Add a normal reviewed maintenance process for provider registry changes; do not create an
      upstream synchronization job.

## 1. Define package and install contracts

### Bundle contract replacement

- [x] Replace the unpublished single-skill envelope with root `plugin.json`, `skills/<name>/`, and
      `dev.orca.skill-sharing/manifest.json`; do not add an outer `bundle/` directory.
- [x] Define `SkillBundleManifestV1` with stable package/version identity, bundle metadata, ordered
      skill entries, per-skill identity and file lists, globally unique archive paths, and a bundle
      digest.
- [x] Validate Agent Plugins 1.0.0 `plugin.json` fields from independently authored local rules;
      never fetch a schema during loading.
- [x] Create fresh staging roots and reject unknown, malformed, or conflicting imported
      `dev.orca.skill-sharing` namespaces without overwriting them. The extractor now exclusively
      creates its staging root, preserves a pre-existing namespace on conflict, rejects unknown
      top-level extension entries, and removes only staging it created.
- [x] Keep the detailed manifest inside the archive for export, remote/SSH transport, and offline
      validation; keep GCS metadata compact and PostgreSQL limited to exact link/ownership lookup.
- [x] Add selected skill IDs and per-skill conflict choices to preview/install requests.
- [x] Return aggregate status plus ordered installed, unchanged, kept-local, and failed per-skill
      outcomes; support retrying failed items only.
- [x] Add `skills.install.bundle.v1` and additive bundle RPC methods so mixed-version peers fail
      before transfer.
- [x] Decide to dispose of the unpublished staging-only single-skill records before changing the
      Cloud schema; there
      is no production compatibility commitment to the unpublished single-skill format.

### Shared package manifest

- [x] Add `src/shared/skill-package-manifest.ts`.
- [x] Define the original single-skill `SkillPackageManifestV1` prototype with schema version,
      stable package ID, immutable version ID, name, description, creation time, file identities,
      and package digest.
- [x] Normalize manifest paths to `/` while keeping filesystem conversion host-owned.
- [x] Define the canonical digest algorithm over normalized paths, file identity, executable state,
      and classification.
- [x] Require `skill/SKILL.md`, valid frontmatter, and agreement between skill and package names.
- [x] Specify deterministic serialization so identical inputs produce identical identities across
      macOS, Linux, Windows, and WSL.
- [x] Version the schema and require additive changes or a new schema version.
- [x] Reject unknown schema versions with a stable error category.

### Package limits and file policy

- [x] Enforce maximum path depth 16.
- [x] Enforce maximum 2,048 archive entries.
- [x] Enforce maximum 512 regular files.
- [x] Enforce maximum 4 MiB per file.
- [x] Enforce maximum 32 MiB total extracted bytes.
- [x] Enforce maximum 40 MiB compressed bytes.
- [x] Reject absolute, parent-traversal, NUL-containing, and Windows drive-prefixed paths.
- [x] Reject duplicate normalized paths and Unicode or case-fold collisions.
- [x] Reject symlinks, hardlinks, devices, FIFOs, sockets, encrypted entries, and other special
      files in V1.
- [x] Preserve executable modes represented by the package manifest.
- [x] Document that install never executes package scripts.

### Install request, preview, and result

- [x] Add `src/shared/skill-install-contract.ts`.
- [x] Define requests with operation ID, immutable package identity, ingress kind, destination, and
      optional conflict resolution.
- [x] Support download-grant, staged-upload, and trusted in-process local-file ingress.
- [x] Ensure arbitrary remote RPC callers cannot supply a local filesystem path.
- [x] Model global, Git worktree, and folder-workspace destinations without assuming Git exists.
- [x] Define preview output for destination, current state, provider coverage, conflicts, and trust
      metadata.
- [x] Define structured installed, updated, unchanged, conflict, partial, and failed results.
- [x] Define stable error categories for admission, transport, archive, filesystem, conflict,
      recovery, provider placement, and compatibility failures.
- [x] Ensure responses never include grants, credentials, ACL membership, or private package
      contents.

### Capability and wire compatibility

- [x] Add `src/shared/skill-install-capability.ts` with `skills.install.v1` and an update-required
      compatibility message.
- [x] Read and apply `docs/reference/remote-wire-compatibility.md` before changing RPC contracts.
- [x] Add new methods without changing existing discovery behavior.
- [x] Keep new request and response fields optional until all supported peers understand them.
- [x] Do not add a terminal stream opcode for skill installation.
- [x] Define behavior for new client/old host, old client/new host, and capability loss during an
      operation.

### Phase 1 contract gate

- [x] Review package, ingress, conflict, result, and capability contracts. Shared schema, runtime
      method, Relay handler, ingress, planner, and stable-failure suites now form the release-gated
      contract evidence; no existing discovery method or stream opcode changed.
- [x] Freeze stable V1 error categories used by desktop, runtime, SSH, and Cloud tests.

## 2. Build and validate packages

### Package creation

- [x] Add `src/main/skills/skill-package-creation.ts`.
- [x] Accept a specific skill directory rather than an arbitrary parent tree.
- [x] Observe and validate the source before staging.
- [x] Copy the source into an owner-private staging directory.
- [x] Observe the staged copy again and fail if its identity differs from the source snapshot.
- [x] Generate a deterministic tar archive with `manifest.json` and a `skill/` envelope.
- [x] Include only `skill/` contents in the eventual installed directory.
- [x] Bind the user-visible share preview to the final staged digest.
- [x] Clean staging files on success, cancellation, source drift, and error.
- [x] Accept a non-empty ordered selection of skill directories and support at least 30 within the
      global entry/file/byte limits. Focused local creation/extraction now covers one 30-skill
      archive; staging load run `31585710645` finalized the same maximum selection through Cloud.
- [x] Reject duplicate normalized skill names and preserve selection across search/filter changes
      in the caller. The picker keeps hidden selections, unions explicit filtered selection, and
      disables a second same-name source before review.
- [x] Generate deterministic `plugin.json`, `skills/`, and Orca extension metadata.
- [x] Bind the share review to every staged skill digest and the final bundle digest.

### Bounded extraction

- [x] Add `src/main/skills/skill-package-extraction.ts`.
- [x] Stream archive inspection and extraction without buffering the entire package.
- [x] Validate `manifest.json` before trusting archive file metadata.
- [x] Enforce compressed, extracted, entry, file, depth, and per-file limits during extraction,
      not only after it.
- [x] Create extraction staging on the same filesystem as the canonical destination.
- [x] Convert manifest paths with the destination runtime's path APIs.
- [x] Re-observe extracted `skill/` and compare every file identity and package digest.
- [x] Delete partial extraction bytes on cancellation or failure.
- [x] Validate the portable root, Orca extension namespace, bundle manifest, and every selected
      `skills/<name>` subtree before destination mutation.
- [x] Extract selected skill subtrees without requiring installation of unselected skills.

### Package tests

- [x] Test deterministic manifests, archives, and digests on macOS and native Windows. The exact
      golden passed on both hosts at `8be7275d0d` after replacing zlib-dependent streaming output
      with bounded deterministic stored DEFLATE blocks.
- [x] Repeat the portable package golden on native Linux and inside WSL.
      The focused golden passed in Debian Bullseye/glibc 2.31 containers on native ARM64 and
      emulated x64, and inside the real Ubuntu 24.04 WSL distro, at `92c8c6a4c6`. The same 26/26
      suite passed at `109272dab1` on a disposable native x86_64 Ubuntu 22.04 GCE host; the VM,
      boot disk, uploaded bundle, and temporary SSH metadata were removed after validation.
- [x] Test source changes during packaging.
- [x] Test CRLF/LF behavior explicitly and document whether byte identity changes.
- [x] Test executable-mode preservation and Windows's mode limitations.
- [x] Test missing, malformed, and identity-mismatched `SKILL.md` files.
- [x] Test every size, count, and depth boundary at limit, one below, and one above.
- [x] Test traversal, absolute paths, drive paths, Unicode/case collisions, duplicate paths, all
      rejected link and special-file types, and encrypted entries.
- [x] Test truncated archives and invalid tar and content checksums.
- [x] Test invalid gzip bytes and map zlib-specific errors to the stable non-retryable archive
      category.
- [x] Fuzz archive path normalization and envelope parsing with bounded resources.

### Phase 2 package gate

- [x] Prove invalid archive classes fail before destination mutation.
- [x] Prove the same source bytes produce the same digest on macOS, Linux, native Windows, and WSL.
- [x] Prove package creation and extraction require no `npx`, external Node installation, or
      upstream CLI runtime.

## 3. Implement the local installer transaction

### Destination resolution

- [x] Add `src/main/skills/skill-install-destinations.ts`.
- [x] Resolve global canonical roots as `<host-home>/.agents/skills/<skill-name>` on the executing
      host.
- [x] Resolve workspace canonical roots from runtime-owned worktree or folder-workspace identity.
- [x] Reject client-supplied remote paths that do not resolve to the selected workspace identity.
- [x] Resolve WSL home, paths, and target distro inside the selected distro.
- [x] Keep all path joins platform-native and reject destination escapes after realpath-aware
      containment checks.
- [x] Support long Windows paths and case-insensitive destination collision checks.

### Admission, locking, and ingress

- [x] Add `src/main/skills/skill-package-download.ts`.
- [x] Add `src/main/skills/skill-install-service.ts`.
- [x] Validate request shape, schema, capability, package identity, scope, destination, and policy
      before download or mutation.
- [x] Recover prior journals for the same destination before planning a new operation.
- [x] Acquire a filesystem-backed cross-process lock keyed by canonical destination.
- [x] Bound lock wait time and return a retryable busy result.
- [x] Stream ingress to an owner-private bounded temporary file and hash it while downloading.
- [x] Require HTTPS whenever the configured Cloud endpoint uses HTTPS.
- [x] Allow only configured Orca skill-bucket origins and reject credential-bearing cross-host
      redirects.
- [x] Check expected compressed bytes, archive SHA-256, package digest, cancellation, grant expiry,
      and disconnects.
- [x] Delete partial ingress bytes on every incomplete path.

### Planning and conflict handling

- [x] Add `src/main/skills/skill-install-planner.ts`.
- [x] Classify missing canonical destinations as installable.
- [x] Classify an identical requested digest as unchanged and continue placement repair.
- [x] Permit clean updates only when installed bytes still match Orca provenance.
- [x] Return a modified conflict when installed bytes drift from their receipt.
- [x] Return an unowned conflict when a destination exists without Orca provenance.
- [x] Return topology conflicts for files, external links, broken links, and name collisions.
- [x] Classify every requested provider placement independently.
- [x] Repeat current-state inspection immediately before commit and invalidate stale previews.
- [x] Require explicit confirmation before discarding local modifications or unowned content.

### Durable commit and recovery

- [x] Add `src/main/skills/skill-install-transaction.ts`.
- [x] Copy extracted bytes into a hidden sibling staging directory and verify the digest again.
- [x] Preserve executable modes where the host supports them.
- [x] Keep staging, replacement, and backup on the destination filesystem.
- [x] Write and durably flush a versioned transaction journal before moving the current
      destination.
- [x] Move an approved existing destination to a journal-owned backup.
- [x] Rename verified staging into the canonical path.
- [x] Add bounded retries for Windows `EPERM`, `EACCES`, and `EBUSY` rename races caused by
      antivirus or indexing.
- [x] Observe the committed destination and require the requested digest.
- [x] Restore the backup after failed commit and retain sufficient journal state after a crash.
- [x] Never remove a path based only on a filename pattern; require journal ownership,
      containment, and expected identities.
- [x] Run bounded recovery at startup and before later operations for the destination.
      Startup scans at most 64 install and 64 removal journals, bounds each read to 4 MiB,
      validates the journal filename against the canonical-path state key, and recovers removal
      before install under the destination lock. Dead-PID locks are reclaimed immediately after a
      killed runtime; malformed locks retain the bounded stale-age safeguard. Corrupt or conflicting
      journals are preserved and reported by path-free failure code for manual recovery.

### Provenance

- [x] Add `src/main/skills/skill-install-provenance.ts`.
- [x] Store versioned receipts outside installed skill directories.
- [x] Record package/version IDs, digest, scope, destination identity, canonical identity,
      placements, previous version, timestamp, and runtime identity.
- [x] Exclude credentials, grants, share values, manifests, and package contents.
- [x] Serialize receipt updates across processes.
- [x] Write receipt updates through durable temporary-file replacement.
- [x] Support aggregate-index reconstruction from bounded per-install receipts.
- [x] Mark the journal complete only after receipt publication, then remove transaction backups and
      staging.

### Verification and discovery

- [x] Re-run skill discovery on the destination after commit.
- [x] Verify the canonical skill and successful provider placements are observable.
- [x] Determine success from installed bytes and discovery, not process exit alone.
- [x] Invalidate renderer skill caches and refresh the Skills page.
- [x] Return canonical success with `partial` when an optional provider placement fails.

## 4. Implement provider placements

### Provider registry

- [x] Add `src/main/skills/skill-provider-destinations.ts`.
- [x] Add data-only records for Orca agent ID, canonical-root support, global/project resolvers,
      detection evidence, and platform alias support.
- [x] Populate only provider paths independently verified from official documentation and real
      installations.
- [x] Detect an agent before creating its provider-specific configuration root.
- [x] Avoid modifying roots for agents that consume `.agents/skills` directly.
- [x] Keep loose-skill placement as the universal/default installation path.
- [x] Do not add Cursor-specific placement in V1; keep the Agent Plugins-compatible root as the
      portable archive shape while installing contained skills through canonical loose-skill paths.
- [x] Do not generate `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` adapters in V1;
      native plugin installation remains a separately reviewed follow-up if it becomes useful.
- [x] Use loose skills for plugin clients, including the current Codex IDE extension, and retain
      bundle/version provenance for every installed skill.

### Placement reconciliation

- [x] Add `src/main/skills/skill-placement-reconciliation.ts`.
- [x] Create relative directory aliases from real parent directories on POSIX.
- [x] Create directory junctions with absolute canonical targets on Windows.
- [x] Detect provider parents already linked to canonical storage.
- [x] Fall back to an independently copied and verified directory when aliases are unavailable or
      denied and policy allows it.
- [x] Record each canonical copy, provider alias, junction, or independent-copy topology.
- [x] Reconcile placements idempotently after install and update.
- [x] Repair broken Orca-owned aliases.
- [x] Leave unowned or modified provider placements untouched unless explicitly replaced.
- [x] Preserve canonical success when a provider placement fails and make coverage retryable.

### Provider validation

- [ ] Confirm every initial provider discovers a global canonical or reconciled install.
- [ ] Confirm every initial provider discovers a workspace install only in that workspace.
- [x] Test symlink, junction, and copy fallback behavior after provider and canonical parent paths
      are moved or linked.
- [ ] Test provider release upgrades against the registry through the normal review process.

## 5. Implement update, rollback, and removal

### Update and rollback

- [x] Resolve the latest accessible immutable Cloud version without mutating local state.
- [x] Compare the requested digest with provenance and observe current bytes before offering an
      update.
- [x] Route clean updates through the same install transaction.
- [x] Offer keep-local, authorized publish-as-new-version, and explicit discard-and-replace choices
      for modified installs.
- [x] Reconcile recorded aliases, junctions, and independent copies during updates.
- [x] Implement rollback as installation of a selected retained immutable version.
- [x] Never invoke `npx skills update` or write ownership metadata for the community CLI.

### Local removal

- [x] Observe the canonical destination and every receipt-owned placement before mutation.
- [x] Remove only aliases or junctions that still target the recorded canonical path.
- [x] Remove independent copies only when they match their receipt unless discard is explicit.
- [x] Remove the canonical copy only when Orca owns it, it is unmodified, and no retained receipt
      depends on it.
- [x] Publish provenance changes durably before completing removal.
- [x] Leave changed or unowned paths intact and report exactly what remains.

### Recovery failure injection

- [x] Inject failure before and after every journal transition.
- [x] Verify partial downloads and extraction staging are deleted.
- [x] Verify a moved destination is restored from backup.
- [x] Verify a placed destination without a receipt is completed or restored according to journal
      state.
- [x] Verify a published receipt with an incomplete journal is finalized safely.
- [x] Verify a restarted process discovers orphaned install and removal journals without a later
      user operation. Deterministic startup tests prove a committed update publishes provenance and
      cleans its dead lock, while an interrupted removal restores both bytes and receipt.
- [x] Verify interrupted placement reconciliation preserves the canonical install and retries.
- [x] Test cancellation during download, extraction, staging copy, commit, provenance, and
      placement reconciliation.

## 6. Provision GCP infrastructure

### Environment and Terraform prerequisites

- [x] Inspect the active `onorca-cloud` project read-only and record the existing Cloud Run, GCS,
      Cloud SQL, IAM, and enabled-service baseline.
- [x] Locate the authoritative Orca Cloud Terraform worktree, state, modules, and deployment
      pipeline.
- [x] Confirm or create a separate staging GCP project before exercising new lifecycle and IAM
      behavior.
- [x] Confirm production names and quotas, including availability of
      `onorca-cloud-skill-packages`. A read-only 2026-08-12 check returned `404` for the global
      bucket name, found no production `orca_skills` database or skill-database secret collision,
      and confirmed the intended existing API service and runtime identity. Cloud Run exposes a
      1,000-job regional quota and 180 job runs per minute, while V1 reuses the existing API at a
      20-instance ceiling and existing Cloud SQL instance; no quota increase is required.
- [x] Confirm `US` storage satisfies initial residency requirements.
- [x] Confirm Cloud SQL connection and PostgreSQL user provisioning conventions.
- [x] Keep Firestore, Cloud Tasks, and new Pub/Sub dependencies out of V1.
- [x] Declare every durable resource and IAM binding in Terraform; do not provision them manually
      with `gcloud`.

### Dedicated GCS bucket

- [x] Declare private bucket `onorca-cloud-skill-packages`, subject to Terraform validation.
- [x] Set location to `US` for parity with current artifact storage.
- [x] Enforce uniform bucket-level access and public-access prevention.
- [x] Configure seven-day soft delete.
- [x] Keep object versioning disabled and record object generations in PostgreSQL.
- [x] Add a one-day deletion lifecycle for `uploads/` quarantine objects only.
- [x] Add exact approved production and development Orca origins to CORS; never use `*`.
- [x] Allow only required signed POST upload and GET/HEAD download behavior and response headers.
- [x] Keep the bucket off public custom domains.
- [x] Define immutable final keys as
      `packages/v1/tenants/<tenant-hash>/sha256/<prefix>/<archive-sha256>/package.tar.gz`, with the
      logical package digest verified in object metadata and PostgreSQL.
- [x] Define tenant-bound random quarantine keys as `uploads/<upload-id>/package.tar.gz`.

### Database and secret

- [x] Declare database `orca_skills` on existing regional PostgreSQL 17 instance
      `orca-cloud-auth-db`.
- [x] Declare dedicated principal `orca_skills_app` with access only to `orca_skills`.
- [x] Store its connection URL in Secret Manager as `orca-cloud-skills-database-url`.
- [x] Attach the existing Cloud SQL instance to `orca-cloud-api` without replacing the service.
- [x] Inject only the skill database secret into the API service.
- [x] Verify backups and point-in-time recovery cover the new database. `orca_skills` shares the
      Terraform-managed Cloud SQL instance whose live staging and production settings both have
      backups, replication-log archiving, seven retained backups, and seven-day PITR enabled.

### IAM

- [x] Grant `orca-cloud-api@onorca-cloud.iam.gserviceaccount.com` bucket-scoped
      `roles/storage.objectUser`.
- [x] Grant the API service account `roles/cloudsql.client` for the existing instance.
- [x] Grant service-account-scoped IAM Credentials `signBlob` for self-signing V4 policies and
      URLs.
- [x] Grant Secret Manager accessor only for skill-specific secrets.
- [x] Verify bucket IAM contains neither `allUsers` nor `allAuthenticatedUsers`.
- [x] Do not grant desktop, remote runtime, or end-user identities direct bucket IAM.
- [x] Do not create or distribute long-lived GCP service-account keys.
- [x] Keep deployment-account permissions unchanged except for reviewed Terraform management
      requirements. Skill sharing adds no deployment-account IAM binding: immutable API and
      monitor-image updates use its existing `roles/run.developer`, while storage inventory and
      scheduling use separate least-privilege service accounts.

### Cloud Run configuration

- [x] Extend `orca-cloud-api` in `us-central1`; do not create a separate V1 worker service.
- [x] Configure bucket, 40 MiB compressed limit, 15-minute upload TTL, five-minute download TTL,
      fixed finalize concurrency, and skill database URL.
- [x] Reuse existing auth base URL and application CORS configuration.
- [x] Stream validation with fixed buffers under the existing 512 MiB memory limit.
- [x] Add a small per-instance finalization semaphore and retryable `429` or `503` with
      `Retry-After` when saturated.
- [x] Preserve current service scaling initially and tune only from measured CPU, latency,
      database, and error data.
- [x] Define criteria for splitting finalization into a worker service if it harms existing API
      traffic.
- [x] Make immutable API candidates atomically replace the complete Terraform-owned literal
      environment and the exact `ORCA_SKILLS_DATABASE_URL` Secret Manager reference.
- [x] Reject serving or candidate drift in the runtime service account, Cloud SQL attachment,
      scaling, CPU, memory, volumes, mounts, ports, and probes before moving traffic.
- [x] Keep all four skill controls explicit in both deploy workflows. Staging changed to `true`
      only with the authenticated OIDC smoke gate; production remains `false`.

### Terraform review and apply

- [x] Format and validate Terraform.
- [x] Produce and review a staging plan.
- [x] Verify the plan does not replace the existing artifact bucket, Cloud SQL instance, Cloud Run
      services, or unrelated IAM.
- [x] Apply to staging and capture resource and IAM verification evidence.
- [ ] Produce and review the production plan after staging gates pass.
- [ ] Apply the approved production plan only during the rollout phase.
- [ ] Verify production with read-only bucket, Cloud Run, database, IAM, lifecycle, and CORS
      commands without printing secret payloads or signed values.

## 7. Implement Cloud metadata and APIs

### PostgreSQL migrations

- [x] Serialize concurrent Cloud Run startup migrations with a transaction-scoped PostgreSQL
      advisory lock before migration-table inspection.
- [x] Prove failed DDL records no schema version and eight concurrent callers converge on one
      version against real PostgreSQL 16 and 17.
- [x] Add `skill_packages` with owner organization, slug/name, creator, timestamps, and deletion
      state.
- [x] Add immutable `skill_package_versions` with package and archive identities, GCS key and
      generation, sizes, manifest, release notes, creator, and publication state.
- [x] Add tenant/user-bound `skill_package_uploads` with quarantine identity, expiry,
      finalization state, and failure category.
- [x] Add `skill_package_acl` for organization and user principals and permissions.
- [x] Add unpredictable, revocable, optionally version-pinned `skill_share_records`.
- [x] Add bounded `skill_package_audit_events` without contents, filenames, or signed values.
- [x] Add unique package slug per organization, immutable version and digest constraints, and
      tenant-scoped archive and final GCS key/generation constraints.
- [x] Add active-share, ACL-principal, and pending-upload expiration indexes. The ACL index remains
      legacy storage and is not used for bearer resolution.
- [x] Add foreign keys preventing blob-reference deletion while a published version uses it.
- [x] Accept and stream-validate both the pre-release single-skill envelope and the new Agent
      Plugins skills-only bundle envelope during the desktop migration.
- [x] Store the detailed bundle manifest in the existing immutable version record; expose it only
      after exact-link bearer authorization or to owners.
- [x] Keep contained skills out of separate database rows and search indexes. Selective inspection
      reads the validated manifest attached to the exact immutable version.
- [x] Keep detailed file identity in the in-archive manifest rather than duplicating it into GCS
      custom metadata. Published-object metadata contains only aggregate archive/package digests
      and immutable generation identity; per-file paths, sizes, modes, and hashes remain inside the
      authorized archive manifest and immutable PostgreSQL version record.
- [x] Test forward migration, rollback strategy, backup restoration, and migration compatibility
      during mixed API versions. Unit coverage proves atomic forward/idempotent migration, ignores
      an additive schema version written by a newer API, and leaves no recorded or partial schema
      after failure. PostgreSQL 16/17 integration coverage proves transactional DDL rollback and
      eight concurrent startup callers converge on one version. Cloud PR `#349` additionally proves
      the older runner and its existing SQL preserve and operate beside a simulated newer additive
      column/table. Cloud PR `#350` requires real old/new Node-process coexistence, writes before
      and after a `pg_dump`/`pg_restore`, and full cleanup on disposable PostgreSQL 16 and 17; both
      PR and merged-main runs passed.

### Authorization and lifecycle model

- [x] Allow share resolution and share-scoped download grants without an authenticated principal.
- [x] Treat an unpredictable active, unexpired share ID as the bearer authorization; do not apply
      legacy package ACLs to recipients.
- [x] Return the same non-disclosing `404` for missing, expired, revoked, or deleted shares.
- [x] Keep authenticated owner checks on upload, finalize, package/version management, share
      creation, revocation, and deletion.
- [x] Apply distributed per-IP abuse limits to anonymous resolution and grant requests without
      persisting raw requester addresses.
- [ ] Apply organization retention and legal deletion rules over product rollback retention.
- [x] Make package deletion revoke shares before dereferencing immutable objects.
- [x] Delete an object only after a transaction proves no retained version references it.
- [x] Design metadata/object reconciliation for partial publication and deletion failures.

### Upload and finalization APIs

- [x] Implement `POST /v1/skill-packages/uploads` with existing authentication, organization
      membership, quota, rate, and concurrency checks.
- [x] Insert a single-use pending upload before issuing a grant.
- [x] Create a 15-minute V4 signed POST policy bound to exact key, content type, upload ID, expected
      archive SHA-256 metadata, and 40 MiB length range.
- [x] Upload directly from the client to GCS without routing package bytes through Cloud Run.
- [x] Implement idempotent finalize by upload ID and manifest identity.
- [x] Validate GCS key, size, type, metadata, tenant, generation, and expiry before streaming.
- [x] Stream once to calculate archive SHA-256 and validate envelope, manifest, paths, limits, and
      package digest.
- [x] Promote with an if-absent generation precondition to the tenant-scoped,
      content-addressed final key.
- [x] If the tenant's final key exists, verify recorded identity without exposing cross-tenant
      package existence.
- [x] Publish the version and complete the upload in a PostgreSQL transaction.
- [x] Delete quarantine bytes after success and rely on lifecycle cleanup for abandonment.
- [x] Make all mutating endpoints accept idempotency keys.

### Package, version, and share APIs

- [x] Implement package creation and version publication under a stable package identity.
- [x] Implement package details and paginated version history.
- [x] Stop accepting organization/selected-user audience fields for new bearer shares; retain
      legacy ACL storage only as migration-compatible data.
- [x] Implement durable share creation with optional pinned version and expiry.
- [x] Implement anonymous bearer-link metadata preview.
- [x] Implement immediate share revocation for new grant requests.
- [x] Implement Cloud package/version deletion with retention and reference checks.
- [x] Implement version update lookup and rollback selection.

### Download grants

- [x] Implement anonymous `POST /v1/skill-shares/<share-id>/download-grants` after fresh active-link
      evaluation.
- [x] Generate a five-minute V4 signed GET URL for the exact immutable key and stored generation.
- [x] Set only response content type and safe attachment filename overrides.
- [x] Grant no list or write capability.
- [x] Return expected archive identity and byte count beside the grant for runtime verification.
- [x] Test revocation immediately blocks new grants while already issued URLs expire within five
      minutes.

### Cloud tests

- [x] Test anonymous latest/pinned preview and download grants without an Authorization header.
- [x] Test missing, expired, revoked, and deleted shares all fail without disclosure.
- [x] Test authenticated owner management remains protected.
- [x] Test anonymous per-IP rate limiting without recording raw IP addresses.
- [x] Test the authenticated owner-only active-link inventory and ensure responses are not cached.
- [x] Test expired, reused, wrong-tenant, wrong-key, wrong-size, and wrong-hash uploads.
- [x] Test malformed, oversized, and resource-exhausting archives during finalization.
- [x] Test finalization semaphore saturation and retry behavior.
- [x] Test concurrent idempotent mutations and partial database/GCS failures.
- [x] Test tenant-scoped deduplication without cross-tenant timing or response disclosure. Orca
      Cloud `ddbd4e2` proves identical archives use distinct tenant-hashed GCS keys and independent
      PostgreSQL object identities.
- [x] Test quota and rate limits.
- [x] Test durable shares resolving intended latest and pinned immutable versions.
- [x] Test update, rollback, revocation, deletion, soft-delete recovery, and orphan reconciliation.

## 8. Implement desktop Cloud client and UX

### Cloud client

- [x] Make share resolution and share-scoped download-grant calls anonymous while keeping upload,
      package/version management, share creation, revocation, and deletion authenticated.
- [x] Keep desktop contracts storage-provider-neutral.
- [x] Implement bounded progress, cancellation, retry, and idempotency behavior.
- [x] Redact signed policies, URLs, credentials, private paths, and package contents at creation.

### Share experience

- [x] Read and apply `docs/STYLEGUIDE.md`; use canonical CSS tokens and shadcn primitives.
- [x] Add **Share skill** to eligible installed and workspace skills.
- [x] Show name, description, author, file count, total size, scripts, executable files, and the
      unlisted-link warning before upload.
- [x] Remove organization and selected-person audience controls from bearer-link publishing.
- [x] Accept optional release label and notes.
- [x] Package the exact previewed bytes and invalidate preview after source drift.
- [x] Show bounded upload and finalization progress with cancellation.
- [x] Return a copyable durable Orca URL after publication.
- [x] Remove access editing from the bearer-share workflow; keep version publishing, revoke, and
      package deletion actions.
- [x] Make clear that unsharing blocks future installs but does not remove installed copies.
- [x] Add **Share skills**, **Install from link**, and installed-package **Manage** to the existing
      Skills page header; expose active link copy/revocation in Settings → **Share Skills** so links
      remain manageable even when the source was never a managed install.
- [x] Add selection mode whose selection survives search/filter changes and an explicit **Select
      all results** action; never select all implicitly.
- [x] Keep the per-card share action as a one-skill bundle shortcut.
- [x] Disable ineligible skills with visible, screen-reader-linked reasons and block duplicate
      skill names before review.
- [x] Review bundle name, skill/file/byte counts, script/executable warnings, expandable per-skill
      details, unlisted-link behavior, and release notes.
- [x] Add Settings → **Share Skills** with artifact-like explanation and a route to the Skills page.
- [x] Show named preparation, upload, verification, and link-publication progress and return one
      durable link for the bundle. Preparation uses **Preparing preview…**; publication advances
      through **Uploading…**, **Verifying package…**, and **Publishing link…** before rendering the
      single durable share URL. Cancellation reaches both upload and link publication.

### Install experience

- [x] Show description, version, digest, file summary, scripts, and executable files without
      exposing internal publisher or organization identifiers.
- [x] Treat the package as code from its author and require an explicit install action.
- [x] Show current-machine global installation as the default.
- [x] Allow selection of connected machine, Git worktree, or plain folder workspace.
- [x] Show detected-agent coverage and canonical/provider topology before commit.
- [x] Show installed-state conflicts and explicit resolution choices.
- [x] Show phase progress without exposing grants or local private paths.
- [x] Render installed, unchanged, updated, partial, conflict, unsupported, cancelled, and failed
      results with actionable recovery.
- [x] Add incomplete-coverage retry.
- [x] Open deep links in inspection mode without starting installation.
- [x] Show immutable version, skill count, scripts/executables, and release notes before selection;
      V1 omits publisher identity from the public response and recipient UI.
- [x] Let the recipient select all or a subset, then choose local, paired runtime, WSL, or SSH and
      global or workspace scope.
- [x] Preview new, unchanged, update, and conflict counts and resolve all per-skill conflicts in one
      surface with **Keep local** as the default.
- [x] Label the primary action **Install N skills** and show aggregate progress plus current skill.
      The destination-owned installer emits the current name and one-based bundle position. Local
      installs forward it directly; paired and SSH hosts expose a capability-gated read-only
      progress method, with phase-only fallback for mixed-version older hosts.
- [x] Group results into installed, unchanged, kept local, and failed; retry failed items only.

### Skills page lifecycle

- [x] Show installed package/version identity and update availability.
- [x] Offer clean update, modified-copy choices, prior-version rollback, and safe local removal.
- [x] Show whether a package came from Orca Cloud and its accessible version history.
- [x] Refresh discovery and installation state after local or remote actions.
- [x] Keep Cloud deletion, share revocation, and local removal clearly separate.
- [x] Add installed-bundle update, rollback, install-on-another-machine, inspect, and remove actions.
      An active unlisted link opens the existing destination-aware installer for another machine.
- [x] Add shared-bundle copy-link, access, revoke, publish-version, and Cloud-delete actions. Exact
      full-bundle version publishing reuses its package; ambiguous or partial managed-bundle
      selections create a new package rather than mutating the wrong history.
- [x] Protect locally modified skills during bundle update and removal, including when only part of
      a bundle remains managed. Keep-local is the default and destructive replacement is explicit.

### UX validation

- [x] Test keyboard shortcuts and labels with platform-aware macOS versus Windows/Linux behavior.
      Skill sharing adds no modifier shortcut or shortcut label. Renderer coverage proves its
      platform-neutral Escape navigation closes the page, leaves editable controls alone, and
      remains owned by open dialogs; the compatibility scan found no hardcoded Meta-only binding,
      macOS glyph, or platform-specific accelerator in the feature.
- [x] Test loading, error, cancellation, partial, conflict, and stale-preview states. Renderer
      coverage includes scan loading, unavailable links, upload/install cancellation, partial
      provider results, keep-local conflicts, capability loss after preview, and selection
      reconciliation after a changed discovery scan; package tests cover source drift.
- [x] Test screen-reader names, focus order, progress announcements, and destructive confirmations.
      The link field receives initial focus, Tab reaches the enabled primary action, Escape closes
      the dialog, and machine, destination, WSL, and workspace selectors have programmatic names.
      Upload progress exposes its phase and numeric value from 0 through publication; dialog-level
      install tests announce authorization, installation, and current-skill position. Link revoke,
      Cloud deletion, and local removal retain focus while switching to exact confirmation names.
- [x] Test long names, release notes, paths, organization names, and localized copy. Renderer
      coverage exercises the 64-character bundle/skill-name boundary, a 10,000-character multiline
      release note, long Unicode descriptions and organization IDs, long Windows-style skill paths,
      and long workspace labels. Review copy wraps without losing full values, selectors constrain
      labels to dialog width, and localization catalog, extraction, and coverage gates pass.
- [ ] Review trust and privacy wording with security and design.

## 9. Implement paired runtime installation

### Runtime and IPC surface

- [x] Register preview, install, update, and remove through runtime RPC and desktop IPC.
- [x] Add bounded `beginUpload`, `uploadChunk`, `commitUpload`, and `cancelUpload` methods.
- [x] Route every request to the runtime that owns the selected host and workspace.
- [x] Keep transfer separate from installation so grants, relayed chunks, and local files converge
      at the validated ingress boundary.
- [x] Make upload sessions bounded by count, total bytes, idle lifetime, and chunk size.
- [x] Require monotonic offsets and idempotent acknowledged-chunk retry or full restart. A stable
      transfer ID and host-acknowledged offset resume a lost begin response or interrupted upload.
- [x] Release staging bytes after cancellation, disconnect, timeout, and runtime restart. Active
      idle timers remove abandoned archives even when no later upload arrives.

### Direct and client-mediated transfer

- [x] Prefer destination-runtime direct download when it can reach approved Orca Cloud storage.
- [x] Verify origin, redirects, generation, byte count, archive hash, and package digest on the
      destination runtime.
- [x] Fall back to authenticated client-mediated chunk transfer when the host cannot reach GCS.
- [x] Never pass the desktop's local path as a remote package source.
- [x] Preserve the same inspection, transaction, provenance, and result behavior for both
      transports.
- [x] Retry an idempotent install after a recoverable lost final response; rebuild a staged
      transfer before retrying so a consumed upload is never reused.
- [x] Run the real Electron client against a paired desktop host for global, Git-worktree, and
      plain-folder install, unchanged preview, inventory, and removal.
- [x] Run the same contract against a paired headless `orca serve` host for global and
      Git-worktree install, unchanged preview, inventory, and removal.
- [x] Verify paired installation creates files only in host-owned roots and never falls back to the
      client's isolated home.
- [ ] Test connection loss and resumption or restart behavior at every transfer boundary. Lost
      final install-response convergence is covered for direct and staged paired-runtime paths;
      deterministic cancellation now settles in-flight and queued paired calls across every
      transport without leaking request admission or disrupting peers. Client-mediated transfer
      also cancels and cleans a fully uploaded session when cancellation interrupts the commit RPC.
      Restart and the remaining physical disconnect boundaries are still open.

### Mixed versions

- [x] Advertise additive bundle installation separately on paired and SSH hosts; never send the
      bundle method to an older peer that lacks `skills.install.bundle.v1`.
- [x] Hide or disable remote install when `skills.install.v1` is absent.
- [x] Show a specific host-update-required message instead of attempting the RPC.
- [x] Test new client/old server and old client/new server.
- [x] Test optional-field omission in both directions.
- [x] Test a capability changing after preview but before execution.
- [x] Confirm older servers retain skill discovery and ignore no unknown stream opcode because none
      is introduced.

## 10. Validate native Windows and WSL on `windows 2`

The connected Orca environment `windows 2` was reachable on 2026-08-11 and ran Orca `1.4.180` with
runtime ID `68b5e70d-baaf-40a5-b384-be09cc088880`. Validation used the isolated checkout
`C:\Users\neil\orca\skills-share-validation` and WSL distro `Ubuntu-24.04`; no production skill
directory was used for destructive failure injection.

The final combined run used workspace `skills-share-staging-validation` at
`C:\Users\neil\orca\workspaces\orca\skills-share-staging-validation` on branch
`OrcaWin/skills-share-staging-validation`. At `44d1266641`, native-Windows, real-process, and real
WSL coverage ran together: 67 files passed, 449 tests passed, and 17 intentional platform skips
remained. The Windows checkout was clean afterward, and WSL `/tmp` contained no remaining
`orca-skill-*` directory.

The 2026-08-11 host inventory recorded Windows 11 Pro `10.0.26200` build `26200`, x64, healthy
NTFS, Windows Defender, `LongPathsEnabled=0`, no Developer Mode registry grant, and an expected
`UnauthorizedAccessException` for an unprivileged directory-symlink probe. The current user home
is `C:\Users\neil` and the temp root is under that profile. WSL `2.7.11.0` uses kernel
`6.18.33.2-microsoft-standard-WSL2`; its only installed distro is the running default
`Ubuntu-24.04` WSL2 instance, with default user `neil`, home `/home/neil`, x86_64, and an ext-family
distro filesystem. No standalone Orca CLI is installed inside that distro; WSL skill operations
are owned by the connected Windows Orca runtime. A reproducible second-distro setup is
`wsl --install -d Debian --no-launch`, followed by first launch and an isolated Orca test user/home
record before the multi-distro gate.

At commit `1e2d2e806f`, the opt-in real-Windows workspace harness created an actual Git linked
worktree and a plain non-Git folder under owner-controlled temporary roots containing spaces and
non-ASCII characters. It installed globally and into both workspace kinds through host-owned IDs,
then removed the complete fixture tree. The full native `src/main/skills` slice passed 284 tests
with 21 intentional platform skips across 43 files, and the Node typecheck passed. Two discovery
fixtures uncovered by that run now use Windows junctions instead of privileged directory symlinks,
matching Orca's supported Windows placement topology.

At commit `cdafe43542`, the opt-in WSL semantics harness used real provider detection and installed
through the selected distro after converting UNC verification paths to distro-native paths. The
run passed both cases: Linux case sensitivity was preserved, regular files were `0600`, executable
files were `0700`, and the packaged script executed successfully. Existing real transaction
coverage also verified POSIX provider alias creation inside the distro.

At commit `92c8c6a4c6`, the exact portable package golden passed 26/26 focused tests from a native
WSL filesystem using an isolated user-owned Node 24 toolchain. The package digest and archive
SHA-256 matched macOS, native Windows, and Linux container results; the temporary WSL toolchain,
source snapshot, dependencies, and package-manager store were removed after the run.

Commit `97b831dd17` stabilized the physical Windows recovery harness by asserting parsed JSON paths
instead of shell-escaped text and by using a fake clock for upload ownership expiry. The combined
run then exposed a real WSL placement bug: native UNC `lstat` could miss an existing distro symlink,
so GNU `ln -s` followed it and created a self-link inside the canonical skill. Commit `44d1266641`
now asks the WSL filesystem whether the alias already targets the canonical path before native
existence checks and uses `ln -sT` for safe creation.

Only `Ubuntu-24.04` is installed on this host. A second-distro permutation is a post-launch
resilience follow-up, not a first-release gate. On 2026-08-12, the owner accepted the additional
live WSL-to-staging journey as duplicate evidence after the physical Windows/WSL matrix and native
Windows Cloud lifecycle passed; the remaining disconnect/cancellation boundaries stay recorded as
residual follow-up work.

### Host preparation

- [x] Confirm `windows 2` is saved and reachable through `orca environment list` and
      `orca status --environment "windows 2" --json`.
- [x] Confirm the host provides both a native Git checkout and a native plain folder workspace.
- [x] Record Windows edition/build, architecture, filesystem type, long-path policy, current user
      home, temp root, antivirus status, and developer-mode/symlink policy without collecting
      secrets.
- [x] Discover installed WSL version and distros, each distro's running state, default user, home,
      filesystem, and Orca host support.
- [x] Ensure at least two WSL distros are available or record a reproducible second-distro setup
      for the multi-distro test.
- [x] Create isolated test skills and destination roots under explicit test workspaces; never use
      production user skill directories for destructive failure injection.
- [x] Record exact Orca client/server versions and capabilities with each test run.

### Native Windows package and destination tests

- [x] Package on macOS and install on native Windows; compare manifest and digest. The physical
      staging journey installed the macOS-published archive with the exact published digest, and
      the portable golden independently matched manifest, package digest, and archive SHA-256.
- [ ] Package on native Windows and install on macOS/Linux; compare identity and executable-mode
      policy.
- [x] Test global home resolution without constructing the path on the macOS client.
- [x] Test a host-owned real Git worktree and plain folder workspace independently.
- [ ] Test path joining, drive prefixes, UNC rejection/handling policy, reserved names, trailing
      dots/spaces, long paths, Unicode normalization, and case collisions.
- [x] Test source and destination paths containing spaces and non-ASCII characters.
- [x] Test junction creation succeeds for a detected provider.
- [x] Force junction denial and verify an independently copied, digest-verified fallback.
- [x] Test an unowned junction, external link, broken junction, and provider parent that is already
      linked. All four real NTFS junction cases passed on `windows 2` at `c7c8a2e32d`; Orca repairs
      only its receipt-owned broken junction and preserves unowned links.
- [x] Test copy-fallback drift during update and removal. Real Windows coverage at `b4f5b6c119`
      proves a locally modified independent copy is skipped during reconciliation and refused
      during removal without changing its bytes.
- [x] Hold destination files open to simulate antivirus/indexer contention and verify bounded
      `EPERM`, `EACCES`, and `EBUSY` rename retries. A real `FileShare.None` lock on `windows 2`
      proved transient recovery and bounded exhaustion at `18fe31f107`.
- [x] Verify retry exhaustion restores the old version and yields an actionable result. The
      transaction preserves the old bytes and returns retryable
      `skill-install-filesystem-failed`; the real Windows source remains intact for retry.
- [x] Terminate the runtime before and after each journal boundary and verify startup recovery.
      The combined physical Windows run passed the real-process extraction, install, removal, and
      upload restart suites, including begun, partial, fully uploaded, and committed upload states.
- [ ] Test permission-denied, read-only, disk-full, cancellation, runtime disconnect, and partial
      provider-coverage paths. Deterministic `EACCES` and `ENOSPC` transaction injection now proves
      the prior installed version remains intact; physical read-only/disk-full and disconnect
      journeys remain open.

### WSL tests

- [x] Execute package ingress, extraction, home resolution, installation, provenance, and discovery
      inside the selected distro.
- [x] Prove the Windows client never constructs a Linux home or mutates the distro through a
      translated Windows path.
- [ ] Post-launch: test global installs for a second distro with a different default user/home.
- [x] Test Linux case sensitivity and executable modes inside the installed distro. Real
      `Ubuntu-24.04` coverage passed at `cdafe43542` with `0600` regular files and `0700`
      executable files.
- [x] Install a multi-skill bundle selectively into a distro-owned home and prove unselected skills
      are absent. The first `windows 2` run found missing filesystem preparation; the fix at
      `70b847c38e` passed all 3 real `Ubuntu-24.04` tests and the temporary worktree was removed.
- [ ] Post-launch: repeat Linux case-sensitivity and executable-mode coverage in a second distro.
- [ ] Test a distro-owned Git worktree and plain folder workspace.
- [x] Test a workspace on the distro filesystem and document behavior for `/mnt/c` separately.
- [x] Test provider detection and POSIX alias creation inside the distro. Real `Ubuntu-24.04`
      provider detection passed at `cdafe43542`; the transaction harness also verified the Claude
      placement as a distro-owned POSIX symlink.
- [ ] Test concurrent native Windows and WSL installs of the same package without provenance or
      lock collision across host identities.
- [ ] Test distro stopped, distro removed, default user changed, home moved, and runtime restarted
      between preview and install.
- [ ] Block outbound GCS access inside WSL and verify client-mediated chunk transfer.
- [ ] Disconnect the macOS client during transfer and commit; verify bounded cleanup and recovery.

### Windows/WSL mixed-version tests

- [ ] Use `windows 2` as old host with a newer client and verify capability-gated UI.
- [ ] Upgrade `windows 2` only through the normal supported update path, then test an older client
      against the newer host.
- [ ] Verify folder-workspace IDs, runtime-owned paths, and results survive client/host version
      skew.
- [x] Capture structured test evidence without signed URLs, tokens, skill contents, or private
      absolute paths beyond approved test fixtures.

### Windows/WSL release gate

- [x] Real native Windows passes junction success, junction denial, verified copy fallback,
      antivirus contention, long paths, crash recovery, Git worktree, and folder-workspace tests.
      The final combined run passed 449 tests across 67 files at `44d1266641`.
- [ ] Real WSL passes distro-owned paths, Linux semantics, provider placement, cancellation, and
      crash recovery tests. Distro-owned paths, semantics, provider placement, and interrupted
      update recovery passed in the combined physical matrix. The owner accepted the additional
      live WSL-to-staging journey as duplicate release evidence on 2026-08-12; physical
      disconnect/cancellation injection remains open, and a second distro is post-launch.
- [x] Temporary local test installations, workspaces, and packages are removed through verified,
      recoverable cleanup. The final checkout was clean and WSL `/tmp` had no `orca-skill-*` debris.

## 11. Implement and validate SSH targets

The 2026-08-11 live Orca inventory contained only the connected `windows 2` environment and no
non-local worktree or repository. Later staging journeys registered disposable Ubuntu 20.04 and
native macOS ARM64 hosts directly through Orca's SSH provider and removed them afterward. A
supported Windows SSH target remains required for its platform-specific gate.

The Docker-backed Linux SSH harness exercises the production Electron → SSH provider → relay →
remote installer path. Its loopback package origin is unreachable from the container, forcing
client-mediated chunk upload. The test independently verifies Cloud request receipts and remote
files for global, Git-worktree, and plain-folder installs, unchanged preview, listing, and removal.
Physical staging journeys additionally passed the supported Ubuntu 20.04/glibc 2.31 floor and
native macOS ARM64; supported Windows remains open.

- [x] Define a host-side installer command that invokes the same installer core and structured
      result contract.
- [x] Transfer immutable packages through the existing SSH/SFTP provider into bounded private
      staging.
- [x] Invoke installation on the SSH host so it owns home, path, provider, and filesystem
      resolution.
- [x] Add capability/version detection for the required host component.
- [x] If unsupported, offer a package download or explicit command; never install into the
      desktop's home as fallback.
- [x] Propagate cancellation and clean partial SSH transfers and staging.
- [x] Route selective bundle installs through an additive SSH method with direct download,
      client-mediated fallback, per-skill results, and old-host capability fencing.
- [ ] Test SSH-only macOS, Linux at the supported floor, and Windows where the existing provider
      supports it. Ubuntu 20.04/glibc 2.31 and native macOS ARM64 passed the full live staging
      lifecycle; supported Windows remains open.
- [x] Test Git worktree and folder-workspace scope over SSH through the disposable Docker Linux
      target and verify the host-owned paths independently.
- [ ] Test connection loss during upload, extraction, commit, provenance, and result return. Lost
      result-return recovery is covered for direct and staged SSH installs; the other physical
      boundaries remain open.
- [x] Prove SSH and paired runtimes return the same result and error-category contracts. The full
      nine-category matrix now passes through both transports with exact code and retryability
      preservation. This exposed and fixed SSH's numeric JSON-RPC code taking precedence over its
      validated structured skill failure; arbitrary error data remains rejected by the strict
      schema.

## 12. Add observability, operations, and security controls

### Metrics and dashboards

- [x] Record bounded package byte/file counts and package, upload, finalization, download, transfer,
      install, placement, and recovery durations.
- [x] Record outcomes by error category, OS, destination kind, transport, conflict type, and
      placement topology.
- [x] Record junction, alias, copy-fallback, rollback, recovery, capability-absence, and orphan
      reconciliation counts.
- [x] Add dashboards for grant/finalize/share rates, authorization and rate limits, finalization
      saturation, archive rejection, and digest mismatch.
- [x] Add Cloud Run 5xx, CPU, memory, instance, and skill-route latency panels and alerts.
- [x] Add GCS quarantine/published bytes, object count, and lifecycle failure panels and alerts.
- [x] Add PostgreSQL connection, storage, query latency, migration, and transaction panels and
      alerts.
- [x] Add signed-policy/URL generation and IAM Credentials failure alerts. Grant-signing failures
      are mapped to a stable application category so the alert does not depend on project-wide
      Data Access audit logging; evidence is in Orca Cloud `69b388e`.
- [ ] Add budget alerts for GCS storage/egress, Cloud Run growth, and Cloud SQL storage.

Dashboard evidence in Orca Cloud `41ef335` and `f67ee2c`: upload-grant, finalize, share, and
download-grant success; bounded security failures; Cloud Run CPU, memory, instances, and latency;
GCS bytes and object count; and Cloud SQL connections, disk use, p99 skill-principal query latency,
and skill-database transaction rate. Cloud PR `#344` passed both required checks and merged as
`fcf8655a`; it adds privacy-bounded migration-ready/failure metrics, a migration lifecycle panel,
and a zero-tolerance migration-failure alert. Its targeted staging plan creates the two metrics and
alert, updates only the dashboard, reruns descriptor propagation, and destroys no infrastructure.
Cloud PR `#345` passed both required checks and merged as `06a5c729`; it normalizes malformed
compression failures to the bounded `skill_package_archive_invalid` category, adds explicit
finalization-saturation and archive-rejection metrics, and displays successful and failed API
operations as rates. The broader unchecked items still require the listed split metrics, lifecycle
visibility, budget coverage, and reviewed alert thresholds. Cloud PR `#346` passed both required
checks and merged as `8199c048`; it adds privacy-bounded per-route latency distributions, sustained
80% CPU/memory and near-instance-ceiling alerts, separate five-second interactive and 30-second
finalization p99 latency alerts, and a route-template p99 dashboard without bearer identifiers.
Cloud PR `#347` passed both required checks and merged as `65320475`; it adds a six-hour
aggregate-only storage inventory job, fixed quarantine/published bytes and object-count metrics,
an overdue-quarantine metric, two storage panels, and an overdue-or-job-failure alert. The monitor
identity has only `storage.objects.list`, while the scheduler can invoke only that job. The reviewed
targeted staging apply added 18 observability resources, updated the existing dashboard, and
replaced only the inert descriptor-propagation timer. A manual run emitted only aggregate fixed-
namespace measurements with zero overdue objects; the post-apply targeted plan is zero-diff, SQL
remained `NEVER`/`STOPPED`, all Relay MIG targets remained zero, and production remained disabled.

Desktop operations now emit local diagnostic spans for package creation, direct upload,
finalization, grant download, client-mediated runtime/SSH transfer, single and bundle install,
provider placement, transaction rollback settlement, and startup recovery. Package bytes/files,
OS, destination kind, transport, conflicts, placement topology/mechanism, copy fallback,
capability absence, recovered transactions, stale extraction/lock cleanup, and failure categories
use fixed or bounded values; bundle error-category cardinality is capped at 32. The implementation
adds no product telemetry event, RPC field, persisted schema, or remote opcode. The skill-sharing
release suite passes 427 tests with 29 expected platform skips, the focused affected matrix passes
102 tests with one expected skip, typecheck and the full lint pipeline pass, and the real-process
macOS recovery matrix passes all 17 crash boundaries. The final combined physical Windows/WSL run
passes 449 tests across 67 files with 17 intentional platform skips; live WSL staging and physical
disconnect boundaries remain separate gates below.

### Logging and privacy

- [x] Log package/version IDs, phases, destination labels, placement outcomes, and bounded error
      categories only.
- [x] Exclude package contents, filenames, manifests, raw local paths, ACL membership, durable share
      URLs, upload policies, download grants, and credentials.
- [x] Redact sensitive network values before logger invocation, not after ingestion.
- [x] Audit authorization and lifecycle events without instruction or script contents.
- [x] Verify diagnostics and support bundles preserve the same exclusions. Desktop install spans
      map requests and results to bounded labels before the tracer boundary; regression coverage
      proves raw paths, filenames, manifests, ACL values, durable share URLs, upload policies,
      download grants, credentials, and raw error text never enter the collected bundle.

### Security review

- [x] Threat-model package creation, archive ingestion, manifest trust, path containment, local
      conflicts, grants, redirects/SSRF, authorization, tenant isolation, and instruction/script
      trust in `docs/reference/agent-skill-sharing-threat-model.md`; keep approval and residual-risk
      acceptance as separate human gates.
- [x] Verify owner-private staging permissions on supported hosts. POSIX download, package,
      extraction, upload-session, provenance, and lock tests require `0700` directories and `0600`
      files; real WSL verifies owner-private executable modes; and the native-Windows privacy suite
      verifies staging remains under the owning profile without broad ACL disclosure.
- [x] Rate-limit uploads, finalization, downloads, share resolution, and remote transfer sessions.
- [x] Test malicious redirects, DNS/host confusion, expired grants, mismatched generations, and
      oversized streaming bodies. Exact HTTPS origins, manual same-origin redirects, URL
      credentials, suffix/port confusion, streamed byte bounds, expiry-before-fetch, and immutable
      GCS generation pinning are covered in Orca `534abb8908` and Orca Cloud `81a581d`.
- [x] Test archive and filesystem race conditions, including source drift and destination changes
      after preview. Package creation re-observes staged bytes, and install commit re-observes the
      locked canonical destination before its first destructive rename.
- [ ] Review organization departure, deletion, retention, soft-delete, and operator recovery.
- [ ] Complete privacy and security sign-off before external rollout.

### Runbooks and kill switches

- [x] Add independent server-side flags for upload grants, download grants, and remote
      installation.
- [x] Verify disabling Cloud grants does not break skill discovery or already installed skills.
- [x] Document finalization saturation, GCS/IAM signing failure, database outage, corrupt package,
      orphan reconciliation, and rollback response.
- [x] Document coordinated PostgreSQL point-in-time and GCS generation/soft-delete restoration.
- [x] Document package/share deletion, organization departure, legal retention, and audit handling.
- [x] Document how and when to split finalization into its own service.

## 13. Complete automated and end-to-end validation

### Transaction matrix

- [x] Test fresh install, identical reinstall, clean update, rollback, explicit replacement, and
      safe removal.
- [x] Test modified and unowned canonical and provider conflicts.
- [ ] Test canonical/provider paths as regular files, directories, aliases, junctions, external
      links, and broken links. Deterministic native coverage now preserves canonical regular-file
      name collisions, unowned provider files/directories, external and broken unowned links,
      Orca-owned broken-link repair, aliases, and verified copy fallback. Physical Windows
      junction coverage remains open.
- [ ] Test concurrent desktop, headless runtime, CLI, SSH, and recovery attempts.
      The shared transaction core now serializes two simultaneous installs into one installed and
      one unchanged result, one receipt, and no staging residue. The host request service also
      serializes simultaneous download-grant and trusted-local ingress requests with the same
      guarantees. A real multi-process harness proves an on-disk destination lock returns a
      retryable busy result without residue, then converges to unchanged after the owning process
      commits and releases; the release gate runs it on macOS, native Windows, and Ubuntu 20.04.
      Named desktop/headless/CLI/SSH/recovery process combinations remain open.
- [ ] Test permission and read-only failures, disk exhaustion, cancellation, process termination,
      and host disconnect. Simulated `EACCES` and `ENOSPC` preservation plus lost-response retry are
      covered; physical failure and termination journeys remain open.
- [x] Test independent-copy drift and incomplete provider coverage. Deterministic transaction
      coverage preserves modified independent copies, retains canonical success when an unowned,
      failed, or cancelled provider placement cannot be reconciled, reports the exact partial
      placement outcome, and repairs interrupted coverage on retry.

### Platform and target matrix

- [ ] Run macOS ARM64 and x64 behavior where supported.
- [x] Run Linux against Ubuntu 20.04/glibc 2.31 and verify bundled native binaries respect the
      floor. The exact x64 directory package passed its 18-binary ABI scan and packaged
      `node-pty` load/spawn smoke inside Ubuntu 20.04 at `f1dccb4f42`. The exact ARM64 directory
      package at `abe92d565b` passed the same 18-binary floor scan and emitted
      `orca-node-pty-floor-ok` from an ARM64 Ubuntu 20.04 container on native `aarch64` hardware.
- [x] Run native Windows and WSL scenarios on `windows 2`.
- [x] Run local and remote Git worktrees and plain folder workspaces. Native Windows covered a
      linked worktree and folder; paired desktop and Docker SSH covered host-owned worktrees and
      folders; physical Ubuntu SSH covered the global lifecycle.
- [x] Run same-build paired desktop and headless runtimes through client-mediated transfer; headed
      coverage includes global, Git-worktree, and plain-folder scopes, while headless coverage
      includes global and Git-worktree scopes.
- [ ] Run paired runtimes with both client-newer and server-newer combinations.
- [ ] Run supported SSH-only macOS, Linux, and Windows targets. Native macOS ARM64 and Ubuntu
      20.04/glibc 2.31 passed full staging lifecycles; supported Windows remains open.
- [x] Run a remote target without outbound Cloud connectivity through chunk transfer. The Docker
      SSH target could not reach the loopback package origin and completed global, worktree, and
      folder installation through client-mediated upload.

### Required journeys

- [ ] Share on machine A, install globally on machine B, launch a detected agent, and discover the
      skill.
- [ ] Share on machine A, install into a folder workspace on a connected runtime, and discover it
      only in that workspace.
- [x] Modify installed bytes, publish an update, and prove Orca refuses silent replacement. The
      browser-free macOS staging lifecycle preserved the modified v1 copy before applying v2 only
      after the explicit test decision.
- [ ] Disconnect during commit, reconnect, recover, and prove either the old or new version is
      complete.
- [x] Revoke a share, prove a new install fails, and prove the existing local install remains.
      Bearer-route tests and staging smoke reject revoked resolution/grants; macOS, native Windows,
      paired, and SSH lifecycles independently preserve already installed bytes.
- [x] Publish a new immutable version, update one machine, leave another pinned, then rollback the
      updated machine. The physical Windows staging journey updated only the remote host to v2,
      retained the local machine's independent version, and rolled Windows back to v1.
- [x] Remove local installation without deleting its Cloud package, then delete/revoke Cloud
      access without mutating another local installation. Staging lifecycles separate host/local
      removal from package deletion, and revocation never mutates either installed copy.

### CI and test evidence

- [x] Add deterministic fixtures authored for Orca without copying upstream fixtures.
- [x] Add failure-injection hooks available only to tests/development harnesses.
- [x] Add a CLI-only developer harness for local and remote integration tests.
- [x] Keep CI commands compatible with macOS, Linux, Windows PowerShell/cmd, and WSL.
- [x] Archive bounded test results and security evidence without secrets or private contents. The
      required release jobs archive bounded machine-readable results; privacy-safe Cloud field
      inventories, load aggregates, and recovery evidence contain no grants or package contents.
- [x] Make package safety, transaction recovery, platform, and mixed-version suites required release
      checks. Release publication now depends on focused macOS, real native-Windows, and Ubuntu
      20.04/glibc 2.31 jobs that archive bounded machine-readable results.

## 14. Stage and release

### Staging

- [x] Apply reviewed Terraform and migrations to staging.
- [x] Deploy `orca-cloud-api` skill routes disabled by server-side flags.
- [x] Enable all four staging controls and pass the GitHub OIDC owner plus anonymous bearer-link
      lifecycle smoke, including owner management, immutable versions, local/remote grants,
      rollback selection, expiry, revocation, deletion, and object cleanup.
- [x] Run staging upload/finalize/download smoke for anonymous denial, oversize, corruption,
      expiry, revocation, deletion, and cleanup; retain tenant-deduplication coverage in the API
      integration suite.
- [x] Run desktop-to-local, paired-runtime, `windows 2`, WSL-equivalent host ingress, and SSH
      journeys in staging.
      Browser-free macOS run `31569902499` passed publish, install, conflict preservation, update,
      rollback, revocation, installed-copy preservation, removal, and Cloud deletion. Physical
      native Windows passed the same lifecycle through run `31591275227`, including remote-owned
      path and digest verification with no macOS fallback. A disposable Ubuntu 20.04/glibc 2.31
      host passed the same SSH lifecycle after guarded wake `31603249983`; guarded sleep
      `31604391897` restored the low-cost state. An isolated headless host passed the paired
      non-Windows lifecycle after guarded wake `31605729090`; guarded sleep `31606600532` restored
      the low-cost state. The physical Windows/WSL matrix separately passed 449 tests on real NTFS
      and Ubuntu 24.04 filesystems. On 2026-08-12, the owner accepted another WSL Cloud lifecycle as
      duplicate evidence rather than a launch gate.
- [x] Give the live staging E2E an owner-private persisted test profile or a short-lived
      non-interactive test credential so reruns do not open PKCE login tabs or copy a user's
      primary Orca session.
- [x] Verify staging application logs contain only route templates, method, status, duration, and
      standard process metadata, with zero credential or private-content matches. Exclude per-link
      Cloud Run platform request logs through Terraform and verify zero are retained.
- [x] Verify logs, metrics, traces, diagnostics, and support bundles contain no grants or private
      package data. The physical SSH window emitted 27 structured route-template events whose
      complete application field inventory was only duration, event, hostname, level, method,
      process ID, route template, status, and time; it emitted zero API error logs. Install traces
      retain only bounded IDs, counts, labels, and enums. The support-bundle suite injects private
      paths, filenames, contents, share URLs, signed grants, policies, ACLs, and credentials and
      proves none survive collection. No skill-sharing product telemetry event is registered.
- [x] Load-test finalization and choose the fixed semaphore from observed memory, CPU, request
      latency, and database usage. Run `31585710645` kept the existing semaphore: its 12 concurrent
      30-skill bundles produced two immediate successes and ten explicit saturation responses,
      1,514 ms client p95, 8.95% API CPU, 26.95% API memory, one API instance, 10.89% database CPU,
      25.59% database memory, and seven database connections.
- [ ] Exercise at least one quarantine lifecycle deletion and published-object soft-delete
      recovery. Published-object recovery passed run `31580071168`; the one-day quarantine
      lifecycle deletion remains time-gated.

### Production infrastructure and launch

- [x] Apply the approved production Terraform plan and verify no unrelated replacement. The saved
      skill-only plan added 40 resources with zero updates, replacements, or deletions; the
      storage-monitor follow-up added one narrow IAM binding with zero changes or deletions. The
      final hardening used two reviewed targeted phases: 13 additions plus one WIF update, followed
      by exactly five broad-IAM deletions. A separate targeted apply made nine in-place
      observability updates. No full plan or unrelated Relay drift was applied.
- [x] Run production database migrations before routing skill traffic. Disabled-route bootstrap
      run `31648015091` completed the skill schema migration before any skill route was enabled.
- [x] Deploy the API with all skill flags disabled. Bootstrap revision `orca-cloud-api-00016-yem`
      received 100% traffic and returned `404` for the disabled skill route while Artifact and Auth
      health remained green.
- [x] After every first-release gate passes, enable the feature for all accounts in one launch.
      Production run `31650178315` initially enabled upload, download, remote install, and sharing
      together. Hardening run `31661421728` then passed candidate and canonical authenticated
      artifact plus skill smoke and promoted `orca-cloud-api-00025-qup` at 100% traffic with digest
      `sha256:e4f044105ff2345574bdceb36eec1629761428cc2edf9d743939390b857d61e0`.
- [ ] Verify one complete share, local install, remote install, update, rollback, revoke, local
      removal, Cloud deletion, upload expiry, and soft-delete recovery journey. Production CI has
      verified the server-side share/version/grant/revoke/delete lifecycle; the signed-in desktop
      and real-host production journey remains manual.
- [ ] Verify upload, download, and remote-install kill switches independently.
- [ ] Review error budgets, cost, authorization denials, saturation, orphan counts, and support
      signals. The hardened production revision has zero post-deploy error logs. All eight skill
      alerts route to the enabled dedicated `Orca skill sharing alerts` channel, and aggregate
      monitor execution `orca-cloud-skill-storage-monitor-lfd26` passed on the serving API digest
      with zero overdue objects. Sustained-usage review remains post-launch.

### Launch operations

- [x] Keep upload grants, download grants, and remote installation independently controllable.
      Separate Terraform-owned Cloud Run variables gate upload/finalize/share publication,
      download grants, and remote-target grants. Route tests prove each narrow control while local
      grants remain available when only remote installation is disabled; staging advertises all
      three explicit controls.
- [ ] Disable the affected operation on unexplained digest mismatch, archive containment failure, data leak,
      unrecoverable local mutation, or cross-tenant authorization defect.
- [x] Publish user documentation for sharing, access, install destinations, updates, rollback,
      removal, retention, and trust in
      [`docs/reference/sharing-agent-skills.md`](./reference/sharing-agent-skills.md).
- [x] Publish admin documentation for organization access, user departure, deletion, and retention
      in [`docs/reference/admin-agent-skill-sharing.md`](./reference/admin-agent-skill-sharing.md).
- [ ] Remove rollout flags only after sustained healthy usage and a reviewed decision.

### First-release gate

- [ ] Threat model and privacy review are approved.
- [x] Cross-platform package and transaction suites are required and green. Release publication
      requires focused macOS, native-Windows, and Ubuntu 20.04/glibc 2.31 jobs with bounded archived
      results; the latest recorded release and platform passes are green.
- [ ] `windows 2` native Windows and WSL release gates pass on real filesystems. The combined run
      passed 449 tests across 67 files, and the owner accepted the additional live WSL Cloud
      journey as duplicate evidence on 2026-08-12. Physical WSL disconnect/cancellation injection
      remains open.
- [x] Real SSH paths and host-owned resolution pass. Native macOS ARM64 and Ubuntu 20.04/glibc
      2.31 independently passed SSH-owned global install, update, rollback, managed inventory,
      revocation preservation, removal, and Cloud cleanup without local fallback.
- [x] Mixed-version tests pass in both directions. Bundle/install capabilities are additive, the
      cross-version wire suite passes client-newer and host-newer, and capability-loss tests prove
      execution is blocked after a stale preview.
- [ ] Cancellation and crash recovery pass during transfer and every commit boundary.
- [x] Durable-share authorization, revocation lag, retention, deletion, and recovery are documented
      and tested. The user/admin guides document the lifecycle; Cloud route, integration, restore,
      and cleanup suites cover the implemented contract. Automatic one-day quarantine deletion
      remains a separate time-gated infrastructure observation.
- [x] The UI identifies scripts and executable content before install without exposing internal
      publisher or organization identifiers. Renderer coverage asserts script and executable
      summaries, digest, release notes, and long-content behavior before the primary install
      action.
- [x] Telemetry, logs, and diagnostic bundles contain no credentials or private contents. Cloud
      field-inventory and sensitive-value scans, bounded install-span attributes, and adversarial
      support-bundle collection tests cover the complete first-release data path.
- [x] Kill switches are tested without affecting discovery or existing installations. Cloud PR
      `#342` proves unlisted-link preview remains available with upload, download, and remote
      installation controls disabled; existing route coverage proves remote-off retains local
      grants. Existing installations and local discovery use only host-owned files and receipts.

## 15. Post-release multi-machine management and reconciliation

- [ ] Measure sharing, installation, update, conflict, fallback, failure, and multi-machine demand
      without collecting private contents.
- [ ] Add **Install on another machine** and bounded multi-machine progress.
- [ ] Add optional desired-version policy for selected personal or organization machines.
- [ ] Add opt-in drift and missing-install reconciliation that never overwrites modifications.
- [ ] Evaluate an explicit, reviewable project desired-state manifest.
- [ ] Evaluate direct machine-to-machine transfer if Cloud persistence is not appropriate.
- [ ] Define offline convergence without durable shared credentials.
- [x] Document organization removal, user departure, package retention, and reconciliation
      semantics before enabling policy-driven installs. The admin guide explicitly leaves legal
      retention and ownership-transfer approval as human release gates.

## 16. Agent and Orca CLI publishing

- [x] Add a separate `agentSkillSharingEnabled` capability that defaults off and accepts only an
      exact persisted `true` value. Manual desktop publishing remains independent.
- [x] Let only the local desktop Settings → Share Skills switch grant the capability. Runtime
      `settings.get` exposes a fail-closed read-only projection; `settings.update`, paired web,
      mobile, agents, and the CLI cannot enable it.
- [x] Add `orca skills installed --json` with discovery IDs and names but no local filesystem paths.
- [x] Add `orca skills share` with repeated explicit `--skill` selectors, a required bundle name,
      one unlisted link for multi-skill bundles, and no `--all` or arbitrary-path input.
- [x] Resolve exact discovery IDs before unambiguous names; fail missing, ambiguous, and duplicate
      bundle-folder names with actionable errors.
- [x] Enforce the capability in the executing runtime before discovery, before package reads, and
      again before publishing. CLI preflight is an optimization, not the authority.
- [x] Reject forwarded WSL, SSH, and paired-runtime CLI contexts before discovery so native file
      APIs cannot read a path belonging to another machine. Native runtimes remain supported on
      macOS, Linux, and Windows.
- [x] Reuse the reviewed bundle preparation and Cloud publisher, propagate RPC cancellation into
      upload, and remove per-operation preparation files after success, denial, cancellation,
      authentication failure, or Cloud failure.
- [x] Admit one agent bundle preparation/publish at a time per host so concurrent agents cannot
      multiply the bounded per-bundle disk and CPU budget.
- [x] Keep CLI JSON limited to the unlisted URL, public share/package/version IDs, bundle name, and
      selected skill summaries; never return auth tokens or source paths.
- [x] Add gate, persistence, RPC grant-denial, selector, archive-content, cancellation, cleanup,
      web mirror, Windows-path contract, CLI parser/help, and Settings UI tests.
- [ ] Complete a live signed-in production publish through the dev CLI, resolve the returned link,
      revoke it, and confirm a later resolution fails while the local source skills remain intact.
- [ ] Complete independent OpenCode and release-readiness review, full repository validation, PR
      CI, and an ad hoc build from the final commit.
