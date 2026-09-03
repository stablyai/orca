# Terraform

This root manages the Orca Cloud relay and nothing else. It requires Terraform >= 1.7
(`removed` blocks); OpenTofu at that floor works too.

## Three roots

Orca Cloud is three Terraform roots sharing one project and one state bucket per environment,
with a different prefix each. They are separate so the relay can be extracted into a public
repository without carrying the app plane, its database passwords, or its Cloudflare credential
with it.

| Root | Directory | State prefix | Owns |
| --- | --- | --- | --- |
| foundation | `infra/terraform-foundation` | `terraform/foundation` | Project service enablement, the Artifact Registry repository, the API runtime service account, the Cloud SQL instance, the GitHub Workload Identity pool, the Cloud SQL rollout lease grant |
| apps | `infra/terraform-apps` | `terraform/apps` | The API and auth services, the artifact and skill-package buckets, the skill plane and its observability, auth and artifact DNS, the app deploy identities |
| relay | `infra/terraform` | `terraform/state` | Everything relay: the director, GCE cells, the fence broker, relay observability, and the relay operator identities |

Apply order on a greenfield project is **foundation first**, then relay and apps in either order.
The other two roots reach foundation only by literal or by `data` lookup, never through
`terraform_remote_state`: foundation state holds the Cloud SQL instance and apps state holds
generated database passwords in cleartext, and the relay root must not acquire a read path into
either once it is public. Each root's substitution for a foundation value is pinned by
`dev/scripts/terraform-root-partition.test.mjs`, which asserts every declared resource family is
owned by exactly one root per environment.

Three families are owned per environment rather than outright: the shared deploy service account,
its Workload Identity provider, and its WIF binding live in the relay root for production and in
the apps root for staging, with complementary counts. Every IAM binding on that account follows
it. `dev/fixtures/terraform-root-partition/families.json` is the authority.

### The carve is complete

Both state surgeries have run (`docs/terraform-root-split-runbook.md`), so this root's state holds
only relay families and the `removed` guard blocks from the window are gone. The shared deploy
identity (`google_service_account.github_deploy`, its provider, and its bindings) is declared here
with production-only counts; staging's copies are declared by `infra/terraform-apps`. An untargeted
plan is orderable again; the `Plan:` line still reflects the standing cell-template drift backlog.

### Dual-accept Workload Identity during the public extraction

While the relay source moves to the public `stablyai/orca` repository, every relay Workload
Identity provider accepts the same workflows from both repositories. `github_accepted_repositories`
lists the extra repositories; `relay-github-workflow-trust.tf` renders one parenthesised OR arm per
accepted repository, each arm carrying that repository's own `repository`, `repository_id`, and
`repository_owner_id` claims plus its exact workflow refs. `ref`, `environment`, and `event_name`
stay outside the OR. Workflow files keep their names in the private repo and take the
`workflow_file_prefix` (`cloud-`) in the public one.

Adding a repository is a tfvars edit: no provider block changes, and the rendered strings are
pinned by `dev/scripts/workload-identity-attribute-conditions.test.mjs`. An empty list renders
byte-identically to the single-repository form, which is what makes the arms reviewable against
the pre-extraction condition.

Closing the cutover is an owner step, in this order:

1. Retire the private workflows, so nothing runs from `stablyai/orca-cloud` any more.
2. Point `github_owner`, `github_repo`, `github_repo_id`, and `github_owner_id` at
   `stablyai/orca` (`1183888342`, owner `127256420`), and set `workflow_file_prefix` for it by
   moving the surviving entry's prefix onto the primary: the public files keep the `cloud-` names,
   so the primary prefix becomes `cloud-` unless the files are renamed back.
3. Empty `github_accepted_repositories` in both `environments/*.tfvars`.
4. Re-render and update the pinned conditions, then apply. Each provider goes back to a single
   arm, and `google_service_account_iam_member.github_accepted_repository_workload_identity_user`
   is destroyed as the primary `attribute.repository` binding takes over.

Step 2 and step 3 must land in the same apply: dropping the accepted entry before repointing the
primary would revoke the public repository mid-flight.

### `ORCA_RELAY_IMAGE_DIGEST` is not Terraform-owned

`deploy-relay-blue-green.mjs` sets `ORCA_RELAY_IMAGE_DIGEST` on the director container at deploy
time, but `relay.tf` does not declare it and the director's `ignore_changes` cannot name a single
list element. A director apply from this root therefore strips that variable. Terraform is not the
owner today: deploy through the director workflow, and treat any direct
`google_cloud_run_v2_service.relay` apply as something that needs the next deploy to restore the
digest. Giving Terraform the variable (a declared input the deploy script writes through) is
tracked as follow-up work in the split checklist, not in this change.

Select a root with `--root`; omitting it keeps the relay root, so existing callers are unchanged.

```sh
pnpm infra:init --env staging --root foundation
pnpm infra:plan --env staging --root apps
```

## Bootstrap Remote State

The GCS backend bucket must exist before `init`.

Staging:

```sh
gcloud storage buckets create gs://onorca-cloud-staging-terraform-state --project onorca-cloud-staging --location us
gcloud storage buckets update gs://onorca-cloud-staging-terraform-state --versioning
```

Production:

```sh
gcloud storage buckets create gs://onorca-cloud-terraform-state --project onorca-cloud --location us
gcloud storage buckets update gs://onorca-cloud-terraform-state --versioning
```

One bucket per environment holds all three roots' state under separate prefixes, so this is a
one-time step for the whole project.

Do not commit `.tfstate`, `.tfplan`, or `.terraform` files.

## Production app deploy identity: moved

The production app deploy identity, the skill alert channel guard, and every
other app-plane resource now live in `infra/terraform-apps`. Their bootstrap
procedure moved with them; run it with `-chdir=infra/terraform-apps`. This root
no longer declares the API service, the auth service, the artifact or
skill-package buckets, the Cloud SQL databases, or the app DNS records, and it
no longer needs a Cloudflare or 1Password credential.

## Staging Relay capacity identity bootstrap

Before the capacity workflow can mutate staging, create a saved targeted plan
containing only `github_staging_relay_capacity` providers, accounts, roles,
bindings, and outputs. Apply it with backend locking, then require a targeted
refresh/no-op plan. The identity is bound to the exact workflow on `main` and
the `staging` environment. Its state write access is limited to the default
staging state and lock object prefix.

Copy these outputs into same-named staging GitHub environment variables:

1. `github_staging_relay_capacity_workload_identity_provider`
2. `github_staging_relay_capacity_service_account`

Before dispatch, prove it can read the saved state and reviewed Relay
resources, but cannot change unrelated Cloud Run services, templates, managed
instance groups, databases, DNS, or secrets.

The identity bootstrap alone does not authorize Relay admin routes. Publish the
compatible image, then use the existing staging blue/green deploy path to carry
and verify the capacity service account on both director revisions. Use saved,
validated cell plans through `Bootstrap Relay Staging Capacity` to roll C2/C3
at 600/60. The reviewed staging tfvars must pin the same image and capacity.
Require a read-only 600/60 capacity-workflow
run before reviewing either 1,000-policy configuration. Do not target the
director with Terraform: its dependency closure includes unrelated live drift.

## Production Relay incident identity bootstrap

Before running the production monitor, create a saved targeted plan containing
only the two dedicated service accounts, their exact-workflow
providers/bindings, and monitor read roles. Reject any Cloud Run, GCE,
database, network, runtime-service-account, or unrelated IAM change. Apply
that plan with backend locking, then run a targeted refresh/no-op plan.

Copy these outputs, in order, into same-named production GitHub environment
variables documented in `.github/workflows/README.md`:

1. `github_relay_monitor_workload_identity_provider`
2. `github_relay_monitor_service_account`
3. `github_relay_fence_workload_identity_provider`
4. `github_relay_fence_service_account`

Use an audited operator session for the GitHub variable writes. Before
dispatch, prove the monitor account can read required aggregate telemetry but
cannot mutate Relay or state. Fence modes remain disabled until a separate
private broker owns and validates the exact state, plan, cell, and durable
attempt boundary; never grant direct Compute update or Terraform-state write
access or director mutations to the GHA fence account.

## Relay Asia topology identity bootstrap

Bootstrap each environment's Asia topology identity with operator credentials
before dispatching its workflow. IAM cannot bootstrap itself. Reinitialize the
exact backend and save a targeted plan that
contains only these twelve additive resources:

1. `google_iam_workload_identity_pool_provider.github_relay_asia_topology`
2. `google_service_account.github_relay_asia_topology`
3. `google_service_account_iam_member.github_relay_asia_topology_workload_identity_user`
4. `google_project_iam_custom_role.github_relay_asia_topology_mutation`
5. `google_project_iam_member.github_relay_asia_topology_mutation`
6. `google_project_iam_custom_role.github_relay_asia_topology_read`
7. `google_project_iam_member.github_relay_asia_topology_read`
8. `google_artifact_registry_repository_iam_member.github_relay_asia_topology_artifact_reader`
9. `google_storage_bucket_iam_member.github_relay_asia_topology_state`
10. `google_project_iam_custom_role.github_relay_asia_topology_state_list`
11. `google_storage_bucket_iam_member.github_relay_asia_topology_state_list`
12. `google_service_account_iam_member.github_relay_asia_topology_runtime_user`

The state-list role contains only `storage.objects.list`. Terraform's GCS backend
needs that bucket-level permission before it can access the exact state and lock
objects protected by the conditional object-admin binding.

Production also requires one exact in-place update to
`google_iam_workload_identity_pool_provider.github[0]` so the existing deploy
identity accepts `operate-relay-asia-admission.yml`; staging's shared provider
already accepts repository workflows. Reject every other change. Apply only
that saved plan, then require the same targeted plan to be empty. Publish the two
`github_relay_asia_topology_*` outputs as the matching staging or production
GitHub environment variables documented in `.github/workflows/README.md`.

Apply observability separately from IAM and topology. The topology identity
has no IAM, logging-metric, alert-policy, Cloud SQL, DNS, certificate, global
IP, or deletion permission. Its read role includes `serviceusage.services.list`
because the Google provider lists managed APIs while refreshing targeted plans.
Its mutation role includes `compute.networks.updatePolicy`, which Compute requires
to attach the reviewed Asia subnet and router to the existing Relay VPC.
It also includes `compute.healthChecks.useReadOnly`, which backend creation requires
to reference the existing Relay readiness health check.
Managed-group creation additionally requires `compute.instanceGroups.create`; adding
that group as a backend requires `compute.instanceGroups.use` and `compute.instances.use`.

Bootstrap the staging Asia proof identity separately before its director roll.
Its targeted plan contains only the proof provider, service account,
workload-identity binding, logging/monitoring viewer bindings, and two outputs. The provider
accepts only `prove-relay-asia-staging.yml` on `main` in the staging environment;
the account has no Compute, Cloud SQL, Secret Manager, Terraform-state, or
Cloud Run mutation permission. Publish its provider and account outputs as
`STAGING_GCP_RELAY_ASIA_PROOF_WORKLOAD_IDENTITY_PROVIDER` and
`STAGING_GCP_RELAY_ASIA_PROOF_SERVICE_ACCOUNT`, then deploy the compatible
staging director so it accepts that exact account for bounded capacity routes.

## Relay regional-placement switch bootstrap

Before the first director deployment that references the regional-placement
switch, apply its Secret Manager resources with operator credentials. Save a
targeted plan containing exactly these six additions and no other changes:

1. `google_secret_manager_secret.relay_regional_placement_enabled`
2. `google_secret_manager_secret_version.relay_regional_placement_enabled`
3. `google_secret_manager_secret_iam_member.relay_regional_placement_runtime_accessor`
4. `google_secret_manager_secret_iam_member.relay_regional_placement_deploy_accessor[0]`
5. `google_secret_manager_secret_iam_member.relay_regional_placement_deploy_adder[0]`
6. `google_secret_manager_secret_iam_member.relay_regional_placement_deploy_viewer[0]`

Pass the exact environment tfvars, apply only
the saved plan, then require the same targeted plan to be empty. Verify the
runtime and deploy identities can access the secret without printing its value, and the deploy
identity can read version metadata without gaining broader mutation rights.
Only then deploy a director revision. Every director revision pins one exact
numeric secret version; the audited director workflow preserves the serving
version by default and creates a new boolean version only for an explicit
enable or disable. The traffic move is therefore the switch commit, and a
failed candidate cannot change the value used by serving instances.
Terraform reads and preserves the currently served director's exact numeric
version, falling back to the bootstrap version only before the setting exists.
It still owns the secret name and every environment field; an unrelated apply
therefore cannot revert a later audited switch version.

## Relay director runtime identity bootstrap

Before the regional-rehome director rollout, create the distinct director
runtime identity with operator credentials. Reinitialize the exact environment
backend, export a fresh `GOOGLE_OAUTH_ACCESS_TOKEN` without printing it, pass
the environment tfvars, and save a targeted
plan containing only the applicable resources below:

1. `google_service_account.relay_director_runtime`
2. `google_project_iam_member.relay_director_runtime_cloudsql_client`
3. `google_secret_manager_secret_iam_member.relay_assignment_signing_key_director_accessor`
4. `google_secret_manager_secret_iam_member.relay_regional_placement_director_accessor`
5. `google_secret_manager_secret_iam_member.relay_database_url_director_accessor`
6. `google_service_account_iam_member.github_relay_director_runtime_service_account_user[0]`
7. `google_iam_workload_identity_pool_provider.github[0]` in production when its
   condition adds the exact regional-rehome and same-cap workflow/job pairs
8. `google_iam_workload_identity_pool_provider.github_production_relay_capacity[0]`
   in production when its condition adds the exact same-cap workflow/job pair

Reject Cloud Run, GCE template, database, network, DNS, or any other change.
Apply only the reviewed saved plan, then require the same targeted plan to be
empty. Publish `relay_director_runtime_service_account` and
`relay_runtime_service_account` as the matching GitHub environment variables
documented in `.github/workflows/README.md`. The identity bootstrap does not
authorize a rollout by itself; use the one-time director workflow mode so both
candidate and rollback revisions move together while rehoming remains durably
disabled.

## Usage

```sh
pnpm infra:init --env staging
pnpm infra:plan --env staging
pnpm infra:apply --env staging
```

Add `--root foundation` or `--root apps` for the other two roots; the default is the relay root.
On a greenfield project apply foundation before either of the others.

Run staging first. Production should only follow after staging has a successful `/health` smoke test.

## Relay staging topology

The stable Cloud Run service is the director. Staging uses fixed-one GCE cells so its data plane
matches production; Cloud Run stamped cells are no longer retained in the live environment.

Staging is intentionally allowed to drift to a powered-off runtime state between internal test
windows. Use the `Power Relay Staging` GitHub Actions workflow to inspect, wake, or sleep it. A
normal `pnpm infra:apply --env staging` refuses while Cloud SQL is stopped or any staging MIG is
scaled below its Terraform-owned size of one. Dispatch `wake` with `wake-cells: all`, wait for its
health checks, and only then apply a reviewed staging plan. Do not use Terraform to wake staging:
that can mix infrastructure changes with a partial power transition.

The staging tfvars keep both Cloud Run services at zero minimum instances. Requests wake the auth
service and director when SQL is running; the power workflow separately controls SQL and the GCE
MIGs. The staging-only GitHub service-account role can resize those MIGs and change the SQL
activation policy. Terraform does not create that role in production.

## Relay GCE production data plane

`relay_gce_domain` creates the shared private network/NAT, LB address, and Certificate Manager
wildcard authorization used by fixed-one GCE cell MIGs. Cells use exact hosts one label below the
domain, such as `c1.relay-staging.onorca.dev`; future cells therefore reuse one DNS-only wildcard
A record while the HTTPS URL map still admits only Terraform-configured exact hosts.

After the foundation apply, publish both Terraform outputs and leave them in place for renewal:

1. `relay_gce_certificate_dns_authorization`: the exact Certificate Manager CNAME.
2. `relay_gce_wildcard_dns_record`: the DNS-only wildcard A record to the reserved LB address.

Every `relay_gce_cells` entry is one durable cell generation and must pin both its exact COS boot
image and its Artifact Registry relay image. Terraform creates one private COS instance template, one size-one zonal
MIG, and one backend service for that exact host. The MIG uses `RECREATE`, zero surge, and one
unavailable worker; `/health` alone drives autoheal while SQL/JWKS-backed `/ready` controls LB
admission. The backend timeout is 86,400 seconds with connection draining, and the URL map aborts
unknown wildcard hosts before they reach a worker. The startup script obtains short-lived metadata
credentials, fetches the two relay secrets without logging them, and runs a digest-pinned Cloud SQL
Auth Proxy beside the digest-pinned relay image.

The primary `us-central1` subnet, router, and NAT retain their original
Terraform addresses. `relay_gce_additional_region_subnetwork_cidrs` creates
only additive regional resources; cells select the subnet from their declared
region. Every cell also declares an explicit database pool maximum in startup
metadata and deployment outputs. The initial Asia shape is `e2-standard-4`,
3,000 physical connections, 60 unobserved connections, 6,000 request units,
and a database pool maximum of 10.

Provision the complete identical Asia wave in one `Deploy Relay Asia Topology`
saved plan. Its validator permits only the additive subnet/router/NAT, reviewed
cell templates/MIGs/backends, and exact shared URL-map host additions. It
rejects deletes, replacements, loss of an existing host route, US-resource
changes, and unrelated drift. Do not add production C27-C29 until the
compatible image has been published and each entry can pin its immutable
digest.

Topology creation intentionally does not apply the director resource. Once all
MIGs and backends are healthy, register every new cell atomically as
migration-only through `Operate Relay Asia Admission` with the exact live
selector generation and a durable attempt ID. Only then may a director
deployment list the new cells. Verify that configuration and fresh heartbeats
before using the same workflow to promote the canary. A failed canary returns to
migration-only; do not delete the Asia network during rollout recovery.

`relay_gce_cells` takes precedence in the director's configured-cell list. Adding or replacing a
generation requires a new map key and hostname; do not change an active cell's image in place. Run
`terraform fmt -check -recursive` and `terraform validate` locally; the same non-credentialed
checks run on every pull request.

GCE deployments must add a distinct cell ID, host, backend, and MIG for every candidate generation;
never update an existing generation's image behind its origin.

For a post-launch worker replacement, first publish an immutable image with the production image
workflow. Add that digest as a distinct `relay_gce_cells` entry with
`initially_enabled = false`, review/apply the Terraform change, and deploy the compatible director.
The production candidate workflow then reads the remote-state topology and defaults to a read-only
preflight. It verifies the exact TLS origin, `/health`, dependency-backed `/ready`, authenticated
heartbeat, served digest, private fixed-one MIG, runtime identity, dedicated backend, 86,400-second
timeout, and authoritative request-unit headroom. `execute` requires the literal `EVACUATE`
confirmation, disables the source only after preflight, enables the candidate, performs bounded
target-first evacuation, drains the exact source origin, and verifies aggregate completion. Keep
both source and candidate Terraform routes until a later reviewed removal proves the old origin has
no assignments, activity leases, or migrations.

After any failure following target registration, use `audit` before `recover-forward`; never retry
`execute` or reverse admission. Forward recovery retries only bounded idempotent status operations.
If every remaining migration belongs to a registered target whose desktop is currently offline, it
emits `candidate_forward_pending` and stops without retiring those rows. Keep both origins intact
and rerun recovery only after a fresh audit shows target controls have returned.

The production multi-target workflow is the reviewed path for evacuations that
need more than one candidate. It enforces deterministic serialized quotas,
target connection ceilings, and the oldest-migration lease gate before drain.
After selector generation 1, add new disabled targets without changing the
director resource in the targeted apply. Deploy the selector-version-2
director, apply only the new cell templates, MIGs, backends, and URL-map
routes, then use `add-migration-cells` to register their exact configs as
migration-only in one selector generation. A single additive target is valid;
ordinary evacuation and supersession retain their multi-target requirements.
Use `retire-migration-cell` with an exact attempt ID to move one
migration-only cell to existing-only before its reviewed fence.
The director does not depend on the GCE forwarding-rule graph; keep director
configuration plans scoped away from immutable cell generations.
Its guarded `fence-source` mode applies an exact private Terraform saved plan
for a fully quiescent cell already listed in `relay_gce_fenced_cells`. The plan
must contain only that MIG's in-place target-size change from one to zero, so
the origin, backend, and generation remain retained. An interrupted apply is
always recovered forward unless Terraform state, live GCE state, and operation
history prove it never began. `abort-fence-source` records that proven
pre-apply abort; remove the cell from the fence set only in a later reviewed
commit. Never resize a production relay MIG directly.
Before the first fencing workflow rollout, apply this schema with an empty
fence set so remote-state topology contains `generation_identity`,
`fenced`, and `desired_target_size`. Only then commit a cell ID into the
production fence set.
The same workflow's `supersede-target` mode is the only supported path for a
failed registered target: it proves the failed MIG is zero with no instances
before recording an exact-incarnation fence and publishing newer epochs.
It invokes an IAM-authenticated max-one Cloud Run broker. The broker runtime
alone can access the exact state/saved-plan/lease object prefixes and update a
Relay MIG; the GitHub requester can read aggregate safety evidence and invoke
that service but cannot perform either mutation directly.
