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

The production Asia set is C27-C30. C27-C29 launched as one wave; C30 is an additive wave of its
own at the same shape. Its plan names C30's template, MIG, and backend plus the shared URL map, and
the URL map pulls every existing cell's backend, MIG, and template into the plan. Committed images
lag what same-cap rolls serve, so the workflow first reads each non-target cell's served image out
of its live template in state and plans that cell at it. It reads the committed cell map from a
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
`relay_cells` lock refusals and pool waits unrelated to C30. C30 was promoted to general on
2026-09-23, so the same-cap job now rolls it as a general cell and the shadow gate's fleet pool list
reads it beside C27-C29. A later Asia cell stays in the same-cap migration-only list and out of the
fleet pool list until its own promotion, then moves to both together, as its own reviewed wave.
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
seals its commit, target and rollback digests, selector generation, and durable rehome generation;
`batch-apply` accepts only that same authority and rolls two to four cells sequentially. Each cell is
isolated, drained to two restart-safe samples, replaced from a targeted saved plan, and restored only
after a new incarnation reports the exact digest, cap, heartbeat, and rehome protocol. The durable
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
   `ROLL_BACK_RELAY_SAME_CAP <rollback-digest> <cell-id>`.
3. The job classifies the cell itself and needs no extra input:
   - serving the **rollback** image and draining, it is `stranded`. The wave stopped before
     or during its template apply. The job re-isolates, re-drains, applies the reviewed
     template, and rolls the MIG explicitly if that template was already in place. The cell
     comes back on a new instance, so the drain clears, and it is restored to its entry class.
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

A mutating dispatch still needs a fresh aggregate monitor dry-run unless the break-glass
override below is used.

### Gate override (break-glass)

Every mutating same-cap wave normally consumes a fresh 15-minute aggregate monitor dry-run.
`gate-override-reason` plus `gate-override-confirmation`, the latter exactly
`SKIP_RELAY_MONITOR_GATE <target-image-digest>`, skips that aggregate evidence and nothing
else. A partial or mismatched override fails the run before any mutation, and `verify` mode
rejects it outright.

It is legitimate when the roll is the fix for the condition the gate is freezing on, or
during an incident with the director healthy. It is not a way to move faster on an ordinary
wave.

The live per-wave preflight still runs, against the same thresholds, with the expected
selector taken from the dispatch inputs and the migration policy pinned to `strict`. That
membership is canonicalised the same way the monitor canonicalises its own, so it must name
every configured cell exactly once and its order does not matter.
Durable rehome disabled, the exact selector generation and membership, the reviewed
Terraform plan, the predecessor and new-incarnation checks, the rollout lease, the
failed-wave failsafe, and single-dispatch mutation are all unchanged. The actor, reason,
and confirmation are recorded in the gate job's run summary and, for a canary, sealed into
the canary artifact under `gateOverride`; a batch may reuse a canary rolled under an
override, because that authority never carried a monitor run ID. See
[gate override (break-glass)](./relay-incident-monitor.md#gate-override-break-glass).

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
