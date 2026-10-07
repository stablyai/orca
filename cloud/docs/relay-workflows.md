# Relay GitHub Actions Configuration

The `cloud-*` workflows in `.github/workflows/` are the Relay deploy and
operate surface. Every one of them is gated on the repository variable
`ORCA_CLOUD_OPERATIONS_ENABLED == 'true'` and does nothing until the repository
owner sets it. The app and auth deploy workflows this document once also
covered stay in the private `stablyai/orca-cloud` repository.

Set these staging environment variables before running the staging deploy workflow:

```text
STAGING_GCP_REGION
STAGING_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER
STAGING_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT
STAGING_GCP_RELAY_CAPACITY_WORKLOAD_IDENTITY_PROVIDER
STAGING_GCP_RELAY_CAPACITY_SERVICE_ACCOUNT
STAGING_GCP_RELAY_ASIA_TOPOLOGY_WORKLOAD_IDENTITY_PROVIDER
STAGING_GCP_RELAY_ASIA_TOPOLOGY_SERVICE_ACCOUNT
STAGING_GCP_RELAY_ASIA_PROOF_WORKLOAD_IDENTITY_PROVIDER
STAGING_GCP_RELAY_ASIA_PROOF_SERVICE_ACCOUNT
```

`STAGING_GCP_REGION` exists today only as a repository variable. Create it as a
staging **environment** variable before deleting any repository-level variable;
`Deploy Relay Staging` gates its whole job on it being non-empty, so a
delete-before-create silently skips it.

The Relay deploy, capacity, and Asia values come from the matching staging
Terraform outputs after the targeted identity bootstrap:

```sh
terraform -chdir=infra/terraform output -raw github_staging_relay_deploy_workload_identity_provider
terraform -chdir=infra/terraform output -raw github_staging_relay_deploy_service_account

gh variable set STAGING_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER --env staging --body '<reviewed output>'
gh variable set STAGING_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT --env staging --body '<reviewed output>'

terraform -chdir=infra/terraform output -raw github_staging_relay_capacity_workload_identity_provider
terraform -chdir=infra/terraform output -raw github_staging_relay_capacity_service_account

gh variable set STAGING_GCP_RELAY_CAPACITY_WORKLOAD_IDENTITY_PROVIDER --env staging --body '<reviewed output>'
gh variable set STAGING_GCP_RELAY_CAPACITY_SERVICE_ACCOUNT --env staging --body '<reviewed output>'
terraform -chdir=infra/terraform output -raw github_relay_asia_proof_workload_identity_provider
terraform -chdir=infra/terraform output -raw github_relay_asia_proof_service_account
gh variable set STAGING_GCP_RELAY_ASIA_PROOF_WORKLOAD_IDENTITY_PROVIDER --env staging --body '<reviewed output>'
gh variable set STAGING_GCP_RELAY_ASIA_PROOF_SERVICE_ACCOUNT --env staging --body '<reviewed output>'
```

The capacity provider accepts only this repository's capacity proof and
bootstrap workflows on `main` with the `staging` environment. It does not fall
back to the shared deploy identity.

The Relay deploy provider accepts exactly five workflows on `main` with the
`staging` environment: Bootstrap Relay Staging Capacity, Deploy Relay Staging,
Deploy Relay Staging GCE Candidate, Operate Relay Asia Admission, and Power
Relay Staging. Set both `STAGING_GCP_RELAY_DEPLOY_*` variables before merging
the workflow repoint; the job gates read them and skip while they are unset.

Set these separately before enabling production deploys:

```text
PRODUCTION_GCP_REGION
PRODUCTION_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER
PRODUCTION_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT
PRODUCTION_GCP_RELAY_MONITOR_WORKLOAD_IDENTITY_PROVIDER
PRODUCTION_GCP_RELAY_MONITOR_SERVICE_ACCOUNT
PRODUCTION_GCP_RELAY_FENCE_WORKLOAD_IDENTITY_PROVIDER
PRODUCTION_GCP_RELAY_FENCE_SERVICE_ACCOUNT
PRODUCTION_GCP_RELAY_CAPACITY_WORKLOAD_IDENTITY_PROVIDER
PRODUCTION_GCP_RELAY_CAPACITY_SERVICE_ACCOUNT
PRODUCTION_GCP_RELAY_ASIA_TOPOLOGY_WORKLOAD_IDENTITY_PROVIDER
PRODUCTION_GCP_RELAY_ASIA_TOPOLOGY_SERVICE_ACCOUNT
PRODUCTION_GCP_RELAY_DIRECTOR_RUNTIME_SERVICE_ACCOUNT
PRODUCTION_GCP_RELAY_RUNTIME_SERVICE_ACCOUNT
```

The Relay operations values come from matching Terraform outputs. Set them as
production GitHub environment variables, not repository fallbacks. Every one of
them is relay-owned in `infra/terraform`:

```sh
terraform -chdir=infra/terraform output -raw github_workload_identity_provider
terraform -chdir=infra/terraform output -raw github_deploy_service_account
terraform -chdir=infra/terraform output -raw github_relay_monitor_workload_identity_provider
terraform -chdir=infra/terraform output -raw github_relay_monitor_service_account
terraform -chdir=infra/terraform output -raw github_relay_fence_workload_identity_provider
terraform -chdir=infra/terraform output -raw github_relay_fence_service_account
terraform -chdir=infra/terraform output -raw github_production_relay_capacity_workload_identity_provider
terraform -chdir=infra/terraform output -raw github_production_relay_capacity_service_account
terraform -chdir=infra/terraform output -raw relay_director_runtime_service_account
terraform -chdir=infra/terraform output -raw relay_runtime_service_account

gh variable set PRODUCTION_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER --env production --body '<reviewed output>'
gh variable set PRODUCTION_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT --env production --body '<reviewed output>'
gh variable set PRODUCTION_GCP_RELAY_MONITOR_WORKLOAD_IDENTITY_PROVIDER --env production --body '<reviewed output>'
gh variable set PRODUCTION_GCP_RELAY_MONITOR_SERVICE_ACCOUNT --env production --body '<reviewed output>'
gh variable set PRODUCTION_GCP_RELAY_FENCE_WORKLOAD_IDENTITY_PROVIDER --env production --body '<reviewed output>'
gh variable set PRODUCTION_GCP_RELAY_FENCE_SERVICE_ACCOUNT --env production --body '<reviewed output>'
gh variable set PRODUCTION_GCP_RELAY_CAPACITY_WORKLOAD_IDENTITY_PROVIDER --env production --body '<reviewed output>'
gh variable set PRODUCTION_GCP_RELAY_CAPACITY_SERVICE_ACCOUNT --env production --body '<reviewed output>'
gh variable set PRODUCTION_GCP_RELAY_ASIA_TOPOLOGY_WORKLOAD_IDENTITY_PROVIDER --env production --body '<reviewed output>'
gh variable set PRODUCTION_GCP_RELAY_ASIA_TOPOLOGY_SERVICE_ACCOUNT --env production --body '<reviewed output>'
gh variable set PRODUCTION_GCP_RELAY_DIRECTOR_RUNTIME_SERVICE_ACCOUNT --env production --body '<reviewed output>'
gh variable set PRODUCTION_GCP_RELAY_RUNTIME_SERVICE_ACCOUNT --env production --body '<reviewed output>'
```

Run those commands only from the audited operator session after the targeted
identity bootstrap apply. The providers require their exact workflows on
`refs/heads/main` with the `production` environment. Missing values fail
closed; no dedicated operations identity falls back to the shared deploy identity.

The shared production identity is restricted to seven named direct Relay callers plus the exact
regional-rehome and same-cap reusable wrapper/job pairs on `main` in the `production` environment.
Its Artifact Registry and Cloud Run mutation permissions are scoped to the Orca repository, Relay
director, and Relay fence broker; it cannot mutate the API or auth services.

Bootstrap the production capacity identity only after its reviewed commit is on
`main`. Reinitialize the production backend explicitly, save the exact targeted
plan, require **9 additions, 0 changes, and 0 deletions**, then apply that saved
plan. `manage_artifact_dns=false` keeps the unimported Cloudflare records out of
this GCP-only operation.

```sh
export GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"
terraform -chdir=infra/terraform init -reconfigure \
  -backend-config=backend/production.hcl -input=false
terraform -chdir=infra/terraform plan -input=false -lock-timeout=30s \
  -var-file=environments/production.tfvars -var manage_artifact_dns=false \
  -target=google_iam_workload_identity_pool_provider.github_production_relay_capacity \
  -target=google_service_account.github_production_relay_capacity \
  -target=google_service_account_iam_member.github_production_relay_capacity_workload_identity_user \
  -target=google_project_iam_custom_role.github_production_relay_capacity_mutation \
  -target=google_project_iam_member.github_production_relay_capacity_mutation \
  -target=google_project_iam_member.github_production_relay_capacity_viewer \
  -target=google_project_iam_member.github_production_relay_capacity_artifact_reader \
  -target=google_storage_bucket_iam_member.github_production_relay_capacity_state \
  -target=google_service_account_iam_member.github_production_relay_capacity_runtime_user \
  -out=/tmp/orca-relay-production-capacity-identity.tfplan
terraform -chdir=infra/terraform show /tmp/orca-relay-production-capacity-identity.tfplan
terraform -chdir=infra/terraform apply /tmp/orca-relay-production-capacity-identity.tfplan
unlink /tmp/orca-relay-production-capacity-identity.tfplan
```

Confirm a second targeted plan is empty before setting the two production
environment variables from reviewed Terraform outputs.

`Deploy Relay Asia Topology` is the only workflow allowed to add the reviewed
`asia-east2` network and fixed-one cell topology. Its dedicated identity is
bound to that exact workflow, `main`, `workflow_dispatch`, and the selected
GitHub environment. The workflow always saves a targeted plan, rejects any
delete, replacement, US-resource, SQL, DNS, certificate, or unrelated change,
and applies only the exact validated plan. It always passes
`manage_artifact_dns=false`; observability and IAM are separate targeted
operations.

Before the first admission operation, publish and deploy a compatible director image while the
topology remains unchanged. Verify the exact serving digest, health, readiness, and rollback tag;
older directors reject the generation-zero membership fingerprint. After a topology apply, use
`Operate Relay Asia Admission` in `inspect` mode to read the exact live selector generation. If and
only if it is generation 0, run
the explicit `initialize` mode with the exact membership SHA-256 printed by
`inspect` and `INITIALIZE_ADMISSION_SELECTOR`; the director checks both under its
database lock, so this freezes the existing membership without adding, removing,
or moving a cell and rejects intervening drift. Then
atomically register the new cells as migration-only, binding every mutation to
the exact live selector generation and a durable attempt ID. Deploy and verify
the director configuration only after registration, then promote C27 alone before C28/C29.

The production Asia set is C27-C31. C27-C29 launched as one wave; C30 and C31 are each an additive
wave of their own at the same shape, and C31 takes `asia-east2-b` so the five cells spread 2/2/1
across the zones. The C30 steps below apply to C31 unchanged, with C31 in place of C30. C30's plan
names its template, MIG, and backend plus the shared URL map, and the URL map pulls every existing
cell's backend, MIG, and template into the plan. Committed images lag what same-cap rolls serve,
so the workflow first reads each non-target cell's served image out of its live template in state
and plans that cell at it. It reads the committed cell map from a
no-refresh, unlocked plan over the same targets, not `terraform console`. Console evaluates every
output against state, so `relay_gce_cell_deployments` wraps each per-cell resource lookup in
`try`: until C30's topology apply, console succeeds and that output shows C30 with null MIG,
backend, and template fields. The validator then rejects any change to a
cell outside the wave, so the plan must read as C30's three creations plus the URL map update.
Before the apply dispatch, run the plan mode and read its `Plan:` line; any other drift, such as a
cell whose startup script changed since its last roll, fails the plan and must be rolled first.
Register C30 alone as migration-only, configure the director with `cell-ids` set to C30 while
regional rehome is paused, then promote it alone. Promotion requires C27-C29 to be general and takes
no input evidence. It runs the same five-minute production control and splice canary C27 ran, on
C30: the evidence must show the canary control was placed on C30, read C30's own runtime metrics,
and bind the selector generation, and any failure returns C30 to migration-only. The SQL-failure and
database-pool rules read C30's own metrics only. Director values are recorded under
`director`-prefixed names but do not fail the canary, because directors show a steady baseline of
`relay_cells` lock refusals and pool waits unrelated to C30. Director region fallbacks are keyed by
the host's target region, and the canary fails on any Asia-targeted one. US-targeted fallbacks are
recorded but not gated: they are placement-lane requests from unhinted or US-preferring hosts, which
an Asia cell cannot cause. Staging still requires exactly its one
intentional fallback. C30 was promoted to general on
2026-09-23, so the same-cap job now rolls it as a general cell and the shadow gate's fleet pool list
reads it beside C27-C29. A later Asia cell stays in the same-cap migration-only list and out of the
fleet pool list until its own promotion, then moves to both together, as its own reviewed wave.
C31 followed that path and was promoted to general on 2026-10-01, so it is now a same-cap general
cell and in the fleet pool list beside C27-C30.

C32 and C33 are US cells at that same 3,000-connection shape, in `us-central1-a` and
`us-central1-b`, and use the same two workflows and the C30 steps. They are declared together, so
they share one topology wave: the live-image step refuses a declared non-target cell with no
template, so a lone C32 plan would fail on C33. Registration, director configuration, and
promotion still take one cell at a time. Each wave's region comes from its reviewed zone. A US wave plans no additional-region network, and its template
carries no region label or region line. Its pool stays at the US default of 10 and emits no pool
line, because 16 exists only for the asia-east2 round trip. Registration and the runtime check
expect `us-central1`. Promotion skips the Asia launch-order gates, which bind Asia cells only.
The canary aims its load at `us-central1`, reads the cell's own `us-central1` metrics, and
requires a US selection. It gates neither region's fallbacks: US-targeted fallbacks have a
nonzero baseline while the US fleet is full, and Asia-targeted ones are not the cell's to cause.
Both are recorded. The US selection gate is a fleet-level check that director metrics flowed; the
placement check is what proves the cell. Placement breaks a load-ratio tie by cell ID, so do not
promote while a same-cap restore has just returned an empty general US cell: the canary control
would land there and the canary would roll the new cell back. Both cells are declared rehome
sources and sit in the same-cap migration-only list until each one's canary promotes it, then move
to the general list. The shadow gate's fleet pool list tracks the 16-connection Asia pools, so
whether a US cell belongs there is decided at promotion, not assumed. Both were promoted to general
on 2026-10-01, so the same-cap job now rolls them as general cells. They stay out of the fleet pool
list because their pool is the US default of 10.

C34 is a sixth Asia cell at the C31 shape in `asia-east2-c`, so the six Asia cells spread 2/2/2. It
was its own topology wave, registered alone as migration-only, and the director was configured with
`cell-ids` set to C34, all on 2026-10-05. It launched as a migration-only spare and has a promotion
wave of its own, with the same five-minute canary C30 and C31 ran. Promotion compares the
director's serving digest and C34's runtime digest with the one `image-digest` input, so C34 was
first rolled to the director's image as a migration-only same-cap wave. Once its canary promoted
it, it moved to the same-cap general list and the fleet pool list together, so the same-cap job now
rolls it as a general cell and a rollback restores it general. It is a declared rehome source.
Rollback returns
Asia cells to migration-only; it does not destroy the network or use
existing-only. The production topology dispatch remains unavailable until the
published compatible image is committed for C27-C29.

`Prove Relay Asia Staging` runs from a dedicated ephemeral repository runner in
`asia-east2` with the `relay-asia-east2-load` label. It promotes only staging C4, runs four bounded
load shards at the exact 3,000/6,000 shape, validates continuous cell/director/Cloud SQL evidence,
and always returns C4 to migration-only before publishing evidence. Register the runner with
`--ephemeral` immediately before dispatch so it accepts one proof job and then removes itself. Each
shard exchanges its
exact workflow OIDC identity for a ten-minute in-memory staging token; no load
credential, signing key, or raw load output is stored or uploaded.

Production promotion evidence must prove the exact production manifest, not an independent rebuild.
Before refreshing C4, target and apply only
`google_artifact_registry_repository_iam_member.github_production_relay_staging_mirror_writer`
from the staging state with `manage_artifact_dns=false`. Run `Publish Relay Production Image` in
`mirror-staging` mode with the exact digest and typed confirmation, then run `Deploy Relay Staging`
with that digest. The mirror validates identical source and target manifest digests; the staging
deploy binds the request to C4's checked-in image and deploys the director by that same digest.
Only then refresh empty migration-only C4 and run the proof. The proof and production promotion both
reject a serving director whose runtime digest differs from the cell/evidence digest.

Expected project IDs:

```text
staging:    onorca-cloud-staging
production: onorca-cloud
```

Production relay delivery keeps the stable director separate from GCE cell rollout. `Publish Relay
Production Image` builds and prints an immutable digest. `Deploy Relay Production Director` accepts
only that digest, performs a health-gated Cloud Run director update, and never deploys data-plane
cell stamps. Its explicitly confirmed prune option retains only the serving and cold rollback pair,
and runs only after both compatible revisions pass the capacity-protocol health gate. Use that gate
before adding Asia cells so an incompatible dormant revision cannot be routed later. A reviewed
Terraform candidate pins the same digest on a distinct disabled GCE cell;
`Deploy Relay Production Candidate` then runs read-only preflight or an explicitly confirmed
target-first evacuation. Staging uses the same GCE data-plane shape as production; `Deploy Relay
Staging GCE Candidate` exercises the reviewed GCE preflight and evacuation state machine before
production use.

`Prove Relay Staging Capacity` is the only cap-transition path. Apply mode
reversibly moves `staging-gce-c3` to migration-only, drains it, validates the
saved director and C3 Terraform plans, updates the director first, and requires
stale telemetry before replacing the exact C3 template and MIG. A fresh
matching heartbeat is required before C3 becomes the sole general placement
cell; C2 remains recoverable in migration-only. Restore mode does not depend on
Terraform or image agreement: it restores C2 first, then restores C3 only after
a fresh, healthy, non-draining capacity check. The same transition order
restores 600 before an older director image can be used.

Its bounded C4 refresh mode keeps Asia admission migration-only, accepts only an exact predecessor
or already-applied target digest, validates a saved two-resource image-only plan, fences and proves
C4 empty before replacement, and requires an empty targeted readback afterward. It cannot change
C4 capacity, routing, trust configuration, or any production resource.

`Recover Relay Staging C4 Image` runs independently after a failed, timed-out, or cancelled C4
refresh and can also be dispatched with `RECOVER_STAGING_ASIA_C4_IMAGE`. It verifies the triggering
job and both exact Terraform end states, preserves a fully converged ready target or predecessor,
and fences partial state before restoring the pinned predecessor through an exact saved two-resource
plan. A separate no-credential supervisor requeues a recovery cancelled while waiting for the shared
staging mutation lane. Admin credentials are refreshed around Terraform. Before the first refresh,
target only
`google_iam_workload_identity_pool_provider.github_staging_relay_capacity`, require exactly one
in-place condition update, apply the saved plan, and require an empty targeted readback.

This identity cannot bootstrap its own Relay authorization. Before the first
capacity dispatch, use the existing audited staging blue/green deploy path to
roll the compatible image and verified `ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT`
onto both director revisions. Roll C2/C3 through saved, validated cell plans
with `Bootstrap Relay Staging Capacity` while they remain at 600/60. That
workflow keeps the deploy identity only for Relay admin calls and uses the
capacity identity for Terraform and GCP mutations. It isolates, drains, rolls,
verifies, and restores one cell at a time, with the other cell as its failure
fallback. Commit the matching
C2/C3 image and capacity pairs in staging tfvars, then require the capacity workflow's read-only 600/60
verification to pass. Only a later reviewed configuration commit may select
1,000/0 or 1,000/60. The capacity workflow carries the reviewed director
topology through blue/green; it never targets the drifted director or its Cloud
SQL dependencies with Terraform.

The one-time bootstrap recognizes only the exact pre-capacity C2/C3 image and
its five-field runtime-status response. It first proves C2 as the general fallback,
then isolates and drains C3 and requires zero durable activity plus two fresh,
instance-bound zero runtime metrics. After restarting the fixed-one MIG, it
requires two new zero samples and a new director heartbeat incarnation started
after the restart before restoring C3. This clears the legacy process's
unreported drain flag without treating missing runtime fields as proof. Any
other image, response shape, activity, or stale evidence fails closed with C2
preserved as the general fallback. Reruns classify partial C2/C3 progress. A
legacy target may carry only no capacity record or the exact stale 600/60 record
before the idempotent director update; afterward the exact stale record is
required until that cell is replaced.

`Power Relay Staging` lowers the staging bill when no internal testing is underway. It runs a
guarded sleep attempt at 09:00 UTC every day and also supports manual `status`, `wake`, and `sleep`
dispatches. Manual mutations require the exact `WAKE_STAGING` or `SLEEP_STAGING` confirmation.
Sleep refuses to stop a cell with active Relay work, disables admission and checks again, then
scales the three GCE MIGs to zero and stops the shared staging Cloud SQL instance. Wake starts SQL,
waits for healthy workers and authenticated heartbeats, then restores only the admission state
declared in Terraform. The default wake starts c1/c2; choose `all` before a Terraform apply or GCE
candidate operation so the complete Terraform-owned topology is running.

`Deploy Relay Production Multi-Target` handles a source that cannot fit on one
candidate. It serializes deterministic per-target quotas, enforces each
target's reviewed 600- or 1,000-connection gate and the ten-minute lease gate,
and treats a drain attempt as the
rollback point of no return. Fence and fence-abort remain fail-closed.
It also registers one additive migration cell and retires exactly one
migration-only cell through explicit, generation-bound selector operations.
Registered-target supersession invokes the IAM-only private broker, which owns
the durable mutation lease, exact Terraform checkout, saved plans, state, and
narrow Compute mutation. The workflow requester has read and broker-invocation
authority only; it never receives those mutation permissions directly.
`Deploy Relay Fence Broker` updates only that service's immutable image and
requires the digest to carry the exact `sha-${GITHUB_SHA}` tag. Terraform
continues to own its identity, scaling, IAM, environment, and deletion
protection.
Its `add-migration-cells` mode is the selector-safe path for newly provisioned
empty targets after generation 1. It requires `ADD_MIGRATION_CELLS` and a
stable selector attempt ID, but no pre-drain artifact because it moves no
assignments. Run the fresh 15-minute gate only after the new cells are
registered and healthy.

## Cloud SQL rollout lease

Every workflow that mints a Cloud Run revision or applies a relay instance template against a shared
Cloud SQL instance takes the compare-and-swap lease in `.github/actions/cloud-sql-rollout-lease`
immediately after `google-github-actions/setup-gcloud`. The per-repository `concurrency` groups
(`production-cloud-sql-rollout`, `relay-staging-mutation`) only serialize runs inside one repository;
once the relay workflows live in `stablyai/orca` there are two queues pointed at one instance, and
`relay-cloud-sql-connection-budget.mjs` computes `rolloutOverlap` as a `Math.max` that is only sound
with one rollout in flight. Keep both the groups and the lease.

| Environment | Bucket                                 | Object                                              |
| ----------- | -------------------------------------- | --------------------------------------------------- |
| production  | `onorca-cloud-terraform-state`         | `terraform/state/cloud-sql-rollout/production.lock` |
| staging     | `onorca-cloud-staging-terraform-state` | `terraform/state/cloud-sql-rollout/staging.lock`    |

`Deploy Relay Asia Topology` and `Operate Relay Asia Admission` pick the pair from
`inputs.environment`. `Deploy Relay Production Capacity` and `Deploy Relay Production Same-Cap` call
their reusable job several times per run, so every wave job acquires with `release: 'false'` under
the run-scoped default holder key and a single `if: always()` `release_lease` job frees it once every
wave has finished.

`Monitor Relay Production` stays off the lease. It is read-only, holds only viewer roles, and putting
it on a durable lease would let monitoring block a rollout and a rollout block monitoring.
`dev/scripts/production-cloud-sql-rollout-lock.test.mjs` enforces the group, the lease wiring, and a
content-derived census of every rollout candidate against
`dev/scripts/cloud-sql-rollout-lock-census.mjs`.

`Monitor Relay Production` is manual and read-only. Its `dry-run` mode enforces the 15-minute
pre-drain gate; `monitor` records a 90-minute incident watch. Both require the
operator to enter the exact selector generation and tri-state membership. The
workflow must use a dedicated identity for aggregate monitoring and
exact-audience read-only Relay-admin calls. Do not dispatch it until that
monitor identity, exact workflow-bound WIF trust, and read-only admin-route
authorization have been bootstrapped.
Capacity-transition monitoring binds the evidence to one exact general cell. It
still blocks all migration failures and any inactive registered migration from
that cell or another serving cell; it permits only inactive rows
from unrelated existing-only cells because a capacity restart neither creates
nor advances assignment migrations.
Reruns restore hash-verified private state from the prior attempt. Production
candidate and multi-target mutations require a fresh dry-run artifact and
recheck its exact selector and every live safety signal before any mutation
command. All three workflows share the production deployment lock, and each
passing dry-run artifact is marked consumed before the mutation starts.
The dry-run lineage fails closed after 25 total minutes, so continuity resets cannot extend the
15-minute gate indefinitely.
Missing or stale telemetry fails closed, and the workflow uploads only private aggregate
Markdown/JSON evidence.

`Deploy Relay Production Capacity` is the only production cap-transition path. It runs only
from `main` and accepts exactly the current general rollout set: C7-C10, C13-C16, and C19-C26.
C17/C18 and every existing-only, draining, fenced, or disabled cell are excluded in code. Its
Terraform/GCE phase uses the dedicated exact-workflow capacity identity. Read-only checks, selector
isolation, drain, and the audited director blue/green update use the existing shared production
deploy identity; the production environment and common deployment lock still gate those steps.
Apply mode consumes a fresh 15-minute monitor gate bound to the selected cell, moves only that cell
from general to migration-only, drains it, updates only its director capacity entry, and applies a
saved validated plan for only its template and MIG. Previously completed 1,000 cells remain
unchanged while later 600 cells roll. The selected cell returns to general only after a fresh
matching 1,000/60 heartbeat. The restart gate waits up to 15 minutes for genuine activity to finish
while preserving every zero-work check. Rollback performs the same isolated sequence to 600/60
without waiting on a cell that may already be unhealthy. If the selected cell cannot answer the
drain call, rollback instead requires two stale-heartbeat snapshots with zero durable activity
before replacing it. Its typed confirmation includes the exact selected cell so a form-selection
mistake cannot downgrade another cell. Interrupted Terraform applies resume only when the planned
current template has the exact reviewed image, capacity, and identity and the remaining change is
that selected MIG update or obsolete-template deletion. Production configuration pins only the
approved serving set to the compatible image and 1,000/60; the transition classifier accepts only
the reviewed mixed 600/1,000 envelope until every selected cell converges. Every GCP-only Terraform
command disables artifact DNS. Any failed mutation leaves only the selected cell migration-only and
never changes another cell's selector state.

After multiple production cells pass the canary path, `wave-apply` may raise two to four reviewed
600/60 serving cells under one fresh 15-minute capacity-transition gate. The first cell is bound to
the sealed evidence; every later cell derives the exact expected selector generation and reruns the
complete live preflight before mutation. After the first cell, continuation preflights retry only
missing or stale signal evidence for at most one minute; health, threshold, selector, and migration
failures stop immediately. Cells still drain, restart, and verify sequentially. A
failed cell stays isolated and prevents every later wave job from starting; earlier completed cells
remain general at 1,000/60. The workflow lock, single-use evidence marker, exact predecessor check,
targeted Terraform plan, and per-cell heartbeat/admission oracle are unchanged.

`Deploy Relay Production Same-Cap` rolls only the reviewed US 1,000/60 and Asia 3,000/60 serving
sets and the two migration-only US 600/60 cells, C17 and C18, without changing a cell's connection
shape. Use `canary-apply` for exactly one cell. A successful canary
seals its commit, target and rollback digests, selector generation, durable rehome generation, and
drain pace window; `batch-apply` accepts only that same authority and rolls two to ten cells sequentially. Both apply
modes and `rollback` first refuse a cell whose hosts (controls) exceed 80% of the free slots on the
other fresh general cells, since drained hosts with nowhere to go keep redialling and pin the cell.
`verify` runs the same read-only check, so it reports the headroom answer before an apply is
dispatched; a rollback that resumes after its restart drains nothing and skips it. A cell's free
slots are its normal admission pause minus the larger of observed connections and enforced units,
minus outstanding control reservations; each moved host also brings its splices, which the 20%
margin covers. Each cell is isolated, drained until restart-safe, replaced
from a targeted saved plan, and restored only after a new incarnation reports the exact digest, cap,
heartbeat, and rehome protocol. Restart-safe means the cell runtime itself carries nothing live (no
controls, in-flight connections, reserved connection units, splices, or queued bytes) and no
migration is open, for a whole drain pace window, which every live restart-safe call must pass.
Pre-auth and total connections are printed but do not reset the window: they include
unauthenticated redials that lose nothing on a restart. Director activity leases left by hosts that already went or cannot
be placed do not hold the restart; every `relay_capacity_transition_restart_progress` sample and
the final verified line report them under `stranded`. The durable
worker must remain disabled throughout. The post-restart trust check is application-mediated by the
director; the workflow never receives or mints a director or stamped-cell runtime token. A failure
keeps only the selected cell migration-only, while the exact rollback digest remains dispatchable via
the same workflow's `rollback` mode.

A roll holds the whole startup script identical before and after except the image, so a
template stale enough to predate a pinned line fails closed rather than absorbing the drift.
The one exception is the capacity identity: a cell that predates it gains it on its next roll,
and the plan validator pins the exact reviewed identity instead of comparing that line, so a
roll can never drop or rewrite it. Any other stale line still fails closed and needs a
convergence apply first.

A drained cell is refused before a roll, because draining means something is already
shedding its connections. A migration-only cell has none to shed, so the flag decides nothing
there and is accepted on entry; the replacement VM is still required not to be draining, and
the incarnation check still proves it was replaced. That also unwedges the state a failed
canary leaves behind, where the wave's own drain set the flag and no restart followed.

C17 and C18 hold no hosts and are not general, so rolling one displaces nobody: they are the
zero-displacement canary for a new image. Their wave enters and leaves migration-only, so its
isolate and its restore are both no-ops and the selector generation does not move; a general
cell's wave still advances it by two. One wave may not mix the two classes, because every cell
after the first offsets from a single per-wave delta. Neither cell is a declared regional-rehome
source, so its template carries no rehome trust lines and it may roll only at rehome protocol `0`;
the job refuses a trusted protocol for it before it plans anything.

### Recovering a wave that died after its drain

A cell's drain flag is a one-way latch on the running process. Only a restart clears it, and
the failsafe that isolates a failed cell does not restart anything. So a wave that stopped
any time after its drain step leaves the cell migration-only and draining, and it stays that
way until the cell is rolled.

Read the failed run before dispatching anything. If its log has a
`"event":"relay_production_capacity_canary","mode":"drain"` line for the cell, the cell is
drained. Then read the cell's live runtime image from
`POST https://<hostname>.relay.onorca.dev/v1/admin/runtime-status`.

1. **Do not re-dispatch `apply`.** It requires the cell general and not draining, and a
   drained cell is neither. It will fail closed at the predecessor check.
2. **Dispatch `rollback`,** with the same `target-image-digest` and `rollback-image-digest`
   the failed wave used, the live selector generation, and the live tri-state membership
   with the failed cell listed under migration-only. The confirmation is
   `ROLL_BACK_RELAY_SAME_CAP <rollback-digest> <cell-id>` at the default drain pace (see
   below for any other).
3. The job classifies the cell itself and needs no extra input:
   - serving the **rollback** image and draining, it is `stranded`. The wave stopped before
     or during its template apply. The job re-isolates, re-drains, applies the reviewed
     template, and, if that template was already in place, recreates the cell's one instance
     with `recreate-instances`. The cell comes back on a new instance, so the drain clears, and
     it is restored to its entry class. The recovery does not use a rolling action: that
     rewrites the MIG's version name outside Terraform. The plan validator does accept a MIG
     moving back to the version name and update policy `relay-gce-cells.tf` declares, so a cell
     an older rolling action left relabelled reconciles on its next apply, roll, or stranded
     rollback. The recreate refuses a MIG that does not hold exactly one instance, such as a
     fenced cell; that failure is the guard, not a fault, so unfence before dispatching.
   - serving the **target** image, it is `roll`, the ordinary rollback. The template applied
     and the instance was replaced.
   - serving the **rollback** image and not draining, it is `resume`: a rollback that failed
     after its own template apply. Nothing is applied and nothing restarts.
4. Rollback takes exactly one cell per dispatch. Recover the cells one at a time.
5. If the run died inside `wait-until stable`, the MIG is still rolling on its own. Wait for
   it to settle and re-read the runtime before dispatching, or the stage will be read off a
   state that is about to change.
6. A `stranded` dispatch that fails at plan review means the template already carries the
   target image while the old instance is still up. Wait for the MIG to finish replacing it,
   then dispatch again; it will classify as `roll`.

### Drain pace ladder

The `drain-pace-window-ms` input sets the window the cell spreads its drain sends over. Each
drained host re-dials the director as soon as it reads `drain`, so the window sets the re-placement
arrival rate: hosts / window, about 1.8-2.7 hosts/s for a US cell at the default. The window also
sets two waits: restart-safe needs an empty runtime for (ceil(window / 5 s) + 1) consecutive
5-second samples, and the drain step's overall timeout is the 15-minute migration lease plus the
window (20 minutes at the default).

- Allowed values are `300000` (the default, and every wave before this input), `60000`, and
  `30000`. The wave validator refuses anything else, and each cell job checks again.
- Below `300000` is for US general cells only (C7-C10, C13-C16, C19-C26, C32, C33). Asia drains
  are bound by the target cells' own accept rate (about 4-6 hosts/s per Asia cell), not by the
  window. Migration-only cells hold no hosts. Both stay at `300000`.
- A non-default window must be named at the end of the confirmation, for example
  `ROLL_RELAY_SAME_CAP <target-digest> <cells> drain-pace-window-ms=60000`. A confirmation that
  names no window confirms `300000`, so a form left at another value fails closed.
- A canary's authority records its window and its pace verdict (below). A batch may use that
  window or a slower one, never a faster one. A batch below `300000` also needs the canary's pace
  verdict to be PASS. Stepping back to `300000` mid-ladder needs no new canary.
- A cell on an image without paced drains rejects the window, and the job falls back to an
  unpaced drain. The job records what the cell accepted, and a canary that did not drain at its own
  window seals `UNVERIFIED`.

**What judges a paced drain.** The shadow health gate (report only, after each cell) judges two
checks the pace can move. Together they are the report's `paceVerdict`, which the canary seals:

- **Director 503s** come from Cloud Run's own request counter (`run.googleapis.com/request_count`,
  code 503), aligned per minute by Cloud Monitoring. A log read of them stops at its entry limit
  in exactly the minutes that matter: it read only 20k of 10-01 c29's ~31k.
- **Scheduled 503s are taken out**, using the director's `orca_relay_runtime_metrics` counters:
  - drain-return deferrals;
  - sticky and placement answers to a host's own early retry (`host-rate-limited`,
    `host-in-flight`).

  Each tells one host when to come back. What is left is lanes, capacity, or the database
  refusing work. On 10-02 the early-retry answers were about three quarters of all 503s, and
  they doubled with placement volume whether or not a drain was running.
- **The background** is the median minute of the 10 same-day minutes before the drain. A busy
  morning raises it with the window, and one incident minute inside it does not.

| check | rule |
|---|---|
| `nonDrain503Budget` | Two consecutive minutes above max(1.5x background, background + 20) warn; above max(2x, background + 40) would-block. One minute above max(10x, 200) would-block on its own; any other single minute is a transient |
| `drainDeferrals` | Warn if the largest Retry-After exceeds 30 s; would-block above 60 s. Reports deferrals and re-placements |

A read that fails, hits its limit, or returns fewer director-metric samples than one instance
emits (one per 30 s) makes both checks `unverified`. An empty answer is not a calm director.

Replayed read-only against past rolls:
- Every brownout and herd replayed is `would-block`: 10-01 c29, 09-23 c27, 09-24 c30, both 10-01
  c28 windows, and the 09-28 and 09-30 herds. Each peaked at 5,999 non-drain 503s a minute or
  more. 10-01 c29, for example, ran 9 minutes in a row over a 41.5/min line.
- Clean rolls: all nine 10-02 cells, 10-01 c25, and 11 other US and Asia rolls have a pace
  verdict of PASS. Their largest minute was 87, and none held two minutes over the warn line.
- Two daytime Asia c29 rolls on 10-01 read WARN and WOULD_BLOCK on sustained non-drain 503s at the
  default pace. Their largest minute was 112, still under the 200 single-minute line.
- These 30 verdicts are unchanged from before the per-minute peak check was folded into this
  one.

The other checks (`cellServing`, `cellPool`, `cloudSqlFatal`, `fleetPool:*`) stay in the overall
verdict as context. They read the new boot and fleet-wide pools, so a clean roll at any pace can
still WARN on them, and every 10-02 roll did on `cloudSqlFatal`.

The report records:
- `background`: the pre-drain minutes;
- `nonDrain503Budget.perMinute`: the per-minute series;
- `drain`: the window, the window the cell applied, the host count, and the seconds from
  isolation to restart-safe.

Two other 503 rules exist, and neither needs this split. The pre-drain sample's 500/min rule reads
the 10 minutes *before* a drain, and a previous cell's drain has ended by then. The incident
monitor already excludes 503s from its director 5xx rule.

**Procedure.** One rung at a time, on routine US same-cap rolls:

1. Before the first rung, run a fresh canary. This input is evidence code, so merging it
   invalidates any sealed monitor or canary authority. Staging has no paced-drain path today: its
   capacity proof drains unpaced. A rung's first use is therefore one production canary.
2. Roll a `canary-apply` at the next rung. Use `60000` after a clean `300000` roll. Use `30000`
   only after a clean `60000` roll, and only once the director reports the drain-return lane's
   service time (`drainReturnServiceMs`, #25645). At 30 s the lane holds only if that time stays
   under about 190 ms.
3. A rung is clean when:
   - the canary job succeeded;
   - its `paceVerdict` is PASS, sealed only from a report on that cell that drained at least 400
     hosts at that pace;
   - time to empty is within window + hosts / 50 s + 10 s. Take `settledAfterSeconds` minus the
     restart-safe quiet; this is an upper bound, since it includes the isolate.

   The batch check enforces the PASS. A canary that sealed anything else authorizes only
   `300000` batches. The 400-host floor exists because a pace is an arrival rate (hosts /
   window). A canary that small would test less than half the rate a 692-782-host US cell
   (10-02) reaches at the same window. Pick a canary cell above it.
4. Record each rung, and keep the shadow gate JSON artifact with the row:

   | Field | Source |
   |---|---|
   | Cell, hosts, window | The report's `drain` block |
   | Measured drain rate | `drainDeferrals.replacementsPeakPerMinute`, and hosts / time to empty |
   | Non-drain 503s | `nonDrain503Budget.perMinute` against `background.medianPerMinute` |
   | Lane deferrals | `drainDeferrals.deferralsTotal` and `retryAfterSecondsMax` |
   | Roll time | The cell job's duration |

   This job does not report four of the rung's bars: drain-to-reconnected p95 (20 s), the
   drain-return lane's service time, over-cap cells (0), and selector compare-and-swap retries
   (at most 2). Read them by hand where a source exists, or record them as unmeasured until the
   director observability work lands.
5. If any bar fails, set the input back to `300000` for the rest of the wave and stop the ladder.
   The `300000` batch needs no new canary.

### Pre-drain fleet-health sample

A same-cap dispatch does not need a separate monitor run. Each `apply` wave samples fleet health
itself, inside its own job, as the last step before it isolates its cell:

1. The live preflight takes one sample against the monitor's thresholds, with the expected
   selector taken from the dispatch inputs (offset for the wave) and the migration policy pinned
   to `strict`. The membership is canonicalised the way the monitor canonicalises its own, so it
   must name every configured cell exactly once and its order does not matter.
2. The headroom check reads how many hosts the cell carries.
3. The pre-drain sample (`pnpm incident:relay-pre-drain-sample`) then samples once a minute for a
   window sized to that count: up to 500 hosts, 3 minutes; up to 1,500, 5 minutes; above that,
   8 minutes. Every sample is judged by the monitor's own evaluator and thresholds, with the same
   tolerance for a flaky cell probe, a director instance replacement, or an unread signal (two
   consecutive samples). Every sample also applies three lookback rules no single reading can
   see: no container exit (`orca_relay_cell_process_exit`) in the last 10 minutes on a cell that
   takes placements (general or migration-only in the dispatch membership) other than the cell
   being rolled, no minute in the last 10 with more than 500 director 503s (a disconnect
   pulse), and director concurrency p99 at most the monitor's 64 over the last 4 minutes. The window does not end on a
   sample that still carries a tolerated failure, and trips if three samples past the window
   still have not come back clean.

The exit metric names only an instance, so each exiting instance is matched to a cell by that
instance's own newest `orca_relay_runtime_metrics` line from the last two hours. The target's own
exits are ignored, because the roll exists to fix them, and so are existing-only legacy cells,
which take no placements. An exit whose instance cannot be matched to a configured cell trips the
rule; a failed lookup counts as a failed read. A newly booted instance can exit several times in
its first seconds while its Cloud SQL proxy sidecar starts (c25's replacement did on
2026-09-28); if that lands within 10 minutes of the next wave's sample, that wave trips and the
remaining cells need a new dispatch.

Any trip fails the wave before isolation, so nothing has changed; dispatch again once the fleet is
quiet. Every later cell in a batch runs all three again, so a batch never drains on health read
before the previous cell rolled. `rollback` runs the live preflight but not the window, because
getting off a crash-looping image must not wait for the crashes to stop; `verify` runs neither.

The monitor workflow itself is unchanged and still gates the rehome enable path and incident
watches. What a same-cap wave no longer has is the 15-minute history before the dispatch; the
sized window plus the 10-minute lookbacks replace it, and the dispatch no longer has to land
within minutes of a monitor run finishing.

The first compatible director rollout uses `bootstrap-runtime-identity=true` with
`BOOTSTRAP_RELAY_DIRECTOR_REHOME_IDENTITY`. That one-time path requires the exact stamped-cell
predecessor identity, creates both the cold rollback and candidate on the distinct director identity,
and proves the disabled durable control through those compatible revisions before moving traffic.
Later director deploys reject the predecessor identity and verify the disabled control on the serving,
rollback, and candidate revisions.

`Operate Relay Production Rehome` is the only durable worker control. `inspect` is read-only;
`enable` is selector-, director-digest-, rollback-digest-, and control-generation-bound, starts at
exactly 10 hosts per minute, consumes the fresh 15-minute safety monitor, and seals 24 hourly buckets
of aggregate requested-region, selected-region, fallback, and unavailable-region evidence with
positive Asia requests and selections. `pause` and `disable` apply their generation CAS immediately
after checkout and authentication, before package installation, revision checks, or log diagnostics.
Their typed confirmations are `PAUSE_REGIONAL_REHOMING` and `DISABLE_REGIONAL_REHOMING`. Keep the
default 3,600,000 ms drain grace so existing splices can finish. The job summary contains only fresh
aggregate active, receipt, registration, completion, and abort counts.

### Director deploy driver

`dev/scripts/drive-relay-director-deploy.mjs` runs a whole director deploy from an operator machine
with `gh` and `gcloud` logged in. It only dispatches the workflows above and reads their results; it
holds no credentials and changes no workflow. It never fills in a workflow's typed confirmation: the
operator types each one when the driver reaches it.

```bash
cd cloud
node dev/scripts/drive-relay-director-deploy.mjs --commit <reviewed main SHA> --dry-run
node dev/scripts/drive-relay-director-deploy.mjs --commit <reviewed main SHA> \
  [--configure production-gce-c34=sha256:<cell image digest>]
```

It keeps no state between runs. Every decision comes from live state read at the start of each run:

- the serving director's digest and configured cells, from `gcloud`;
- the admission selector, from an `Operate Relay Asia Admission` `inspect`;
- the rehome control, from a rehome `inspect` at the generation the newest rehome run printed, or
  at `--rehome-generation`.

Steps already done are skipped: a serving digest that matches is not deployed again, and cells
already configured are not configured again. It always reads rehome, even when nothing is left to
do, so it never reports success over a pause it cannot explain.

The sequence:

1. **Publish.** No `cloud-*` workflow is queued or running (all pages; the hourly clock-skew
   monitor and `cloud-verify` excepted), and `main` is the reviewed commit. The publish workflow
   builds whatever `main` is when it is dispatched, so the driver dispatches it straight after that
   check, before the inspects and the typed phrase. It changes nothing serving, so a bad build needs
   no cleanup. The digest is the registry digest of `relay:sha-<commit>`, and the run's own push
   line must name the same digest. If `main` still moved in those seconds, the driver stops and
   names the `--commit <built> --publish-run <run>` that deploys that build once it is reviewed.
2. **Preflight, read-only**, then the operator types `DEPLOY <commit prefix>`.
3. **Pause**, only if rehome is enabled, after the operator types `PAUSE_REGIONAL_REHOMING`.
4. **Deploy** with that digest, the paused generation, `preserve` for both regional inputs, no
   prune, and the old serving digest as predecessor.
5. **Soak**, with `--configure` only, while no wave is configured yet. It watches 5 minutes of
   director 5xx and stops if they exceed twice the 5 minutes before the new revision existed, plus
   25. The window starts at the traffic switch (a minute before the deploy run completed) when this
   run deployed, otherwise at the time of the run, so a re-run judges fresh traffic. It is read a
   minute late, to allow for log lag. Then the operator types `CONFIGURE_ASIA_DIRECTOR` and each
   pending wave is configured.
6. **Digest check.** A rehome `inspect` bound to the serving and rollback digests that `gcloud`
   reports now. A wrong digest fails here, read-only, before 15 minutes of monitor evidence is
   spent on it.
7. **Monitor.** The operator types `ENABLE_REGIONAL_REHOMING`. The prompt says this arms an
   automatic enable, sent about 17 minutes later, and only if the monitor is green and its evidence
   is at most 150 s old. The monitor dry-run then starts. Its artifact passes the same
   `relay-monitor-evidence.mjs verify-authority` check the enable job runs.
8. **Enable** with the verified digests, within 150 s of the monitor completing.

Steps 6 to 8 run only for a pause this driver owns.

**Ownership.** The driver owns a pause only if it can name the run that made it, and the live
control is still at that run's generation. Two kinds of line in a run's log prove it paused
rehome:

- `pause`;
- `recover-enable` with `recovered: true`, meaning a failed enable that disabled rehome again itself.

The run must be a rehome-control run by the same GitHub user. A `recover-enable` with
`recovered: false` found rehome already disabled, for example by a director safety pause, and is
never adopted. A failed enable run is never counted as an enable, whatever it printed last. A fresh run that finds rehome paused stops. It goes ahead only
with:

- `--pause-run <run>`, which an earlier run of this driver printed; or
- `--leave-rehome-paused`, which deploys and leaves rehome paused. It refuses an enabled switch.

A pause made by anything else is never lifted.

**Stops.** On any failure, Ctrl-C, SIGTERM or SIGHUP, the driver prints what changed:

- `REHOME IS CHANGING` when a pause or enable run is in flight and will apply on its own;
- `PAUSE UNCONFIRMED` or `ENABLE UNCONFIRMED` when such a run printed no usable result;
- `REHOME IS PAUSED by this driver` with the owning run;
- the serving director, re-read;
- the published digest;
- the rollback point, with the `gh workflow run` command that redeploys it.

It ends with the single command that finishes from where it stopped. That command carries
`--publish-run` and `--pause-run`, and the driver re-verifies both against the runs' logs and live
state. Each run writes a timestamped log under `~/.orca/relay-director-deploy/`
(`--log-directory` overrides it).

## Mobile push gateway

`Deploy Push Gateway Production` (`.github/workflows/cloud-push-deploy.yml`) is the deploy path
for `orca-cloud-push`, the mobile push gateway. It is the one `cloud-*` workflow that is not a
relay operation, and it is here because it shares the Artifact Registry repository and rollout
lease. Push uses a dedicated Cloud SQL instance.

It authenticates through `PRODUCTION_GCP_PUSH_DEPLOY_WORKLOAD_IDENTITY_PROVIDER` and
`PRODUCTION_GCP_PUSH_DEPLOY_SERVICE_ACCOUNT`. The dedicated identity has Artifact Registry writer,
Cloud Run developer on the push service, and impersonation of only the push runtime account.
Its provider pins the repository, production environment, main branch, and exact dispatch workflow;
its distinct principal attribute cannot assume the shared Relay deploy account.

Foundation grants the dedicated account access to the rollout-lock prefix and bucket metadata.
Apply that companion grant and publish the identity outputs before running the workflow. See
[push gateway deployment setup](./push-gateway.md#deploying) for the activation steps.

The run builds the exact reviewed image digest before taking the lease and rejects images
without validation-mode support using a network-isolated container. Under the lease it boots
an inert, read-only validation revision, checks readiness, mode, scaling and FCM credentials,
then deletes it before deliberately activating the same digest in a new revision. Activation
starts schema writes, pruners and queue consumers before HTTP promotion. Rollback requires
restoring traffic, deleting the rejected active revision, and restoring the service template to
the known-good image in normal mode. The untagged template-recovery revision can run known-good
workers and is retired before lease release; see the
[deployment and rollback contract](./push-gateway.md#deploying).
