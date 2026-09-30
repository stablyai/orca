# The staging Relay deploy identity.
#
# In production the shared `github_deploy` account is relay-owned; in staging it belongs to
# infra/terraform-apps and four app workflows can also mint it. These resources give the five
# staging Relay workflows their own account, provider, and bindings so the relay root owns every
# credential its own workflows use.
#
# Bindings that already name local.relay_github_deploy_service_account_member follow that local
# (relay-shared.tf) and are NOT repeated here: the staging power custom role, serviceAccountUser
# on relay_runtime and relay_director_runtime, and the three regional-placement secret bindings.
# Everything below replaces a grant the apps root still makes to `github_deploy`.

locals {
  create_staging_relay_deploy_identity = (
    local.relay_create_github_deploy_identity && var.environment == "staging"
  )
  github_staging_relay_deploy_workflow_files = [
    "bootstrap-relay-staging-capacity.yml",
    "deploy-relay-staging-gce-candidate.yml",
    "deploy-relay-staging.yml",
    "operate-relay-asia-admission.yml",
    "power-relay-staging.yml"
  ]
  github_staging_relay_deploy_workflow_clauses = [
    for prefix in local.relay_github_workflow_ref_prefixes :
    "(${join(" || ", [for workflow_file in local.github_staging_relay_deploy_workflow_files : "assertion.workflow_ref == '${prefix}${workflow_file}@refs/heads/main'"])})"
  ]
  # Apps-owned account the shared staging power workflow scales to zero alongside the director.
  staging_auth_runtime_service_account_email = "${var.name_prefix}-auth@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_service_account" "github_staging_relay_deploy" {
  count = local.create_staging_relay_deploy_identity ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-gha-relay"
  display_name = "Orca Relay staging deploy"
  description  = "Runs the exact reviewed Relay staging deploy, candidate, power, and admission workflows."
}

resource "google_iam_workload_identity_pool_provider" "github_staging_relay_deploy" {
  count = local.create_staging_relay_deploy_identity ? 1 : 0

  project                            = var.project_id
  workload_identity_pool_id          = local.relay_workload_identity_pool_id
  workload_identity_pool_provider_id = "github-relay-deploy"
  display_name                       = "GitHub Relay staging deploy"

  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository"          = "assertion.repository"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.ref"                 = "assertion.ref"
    "attribute.environment"         = "assertion.environment"
    "attribute.workflow_ref"        = "assertion.workflow_ref"
    "attribute.relay_ops_identity"  = "'staging-deploy'"
  }

  # An allowlist of exact workflow refs, never a prefix: a namespace grant would hand this account
  # to any future staging workflow with no Terraform diff.
  attribute_condition = join(" && ", concat(local.relay_github_leading_repository_claims, [
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == 'staging'",
    local.relay_github_workflow_conditions["github_staging_relay_deploy"]
  ]))

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_staging_relay_deploy_workload_identity_user" {
  count = local.create_staging_relay_deploy_identity ? 1 : 0

  service_account_id = google_service_account.github_staging_relay_deploy[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.relay_workload_identity_pool_name}/attribute.relay_ops_identity/staging-deploy"
}

# Every one of the five runs `terraform init` (or `infra.mjs init --env staging`) first, and the
# GCS backend lists the bucket before it can open the state. Bucket metadata only, no object
# access; this mirrors relay_fence_broker_bucket_reader.
resource "google_storage_bucket_iam_member" "github_staging_relay_deploy_state_list" {
  count = local.create_staging_relay_deploy_identity ? 1 : 0

  bucket = "${var.project_id}-terraform-state"
  role   = "roles/storage.legacyBucketReader"
  member = google_service_account.github_staging_relay_deploy[0].member
}

# Reads reviewed topology: `terraform output -json relay_gce_cell_deployments` and the
# `terraform console` binds in Deploy Relay Staging. No step in the five applies, so this is
# objectViewer, not the capacity identity's objectAdmin, over the same two objects.
resource "google_storage_bucket_iam_member" "github_staging_relay_deploy_state" {
  count = local.create_staging_relay_deploy_identity ? 1 : 0

  bucket = "${var.project_id}-terraform-state"
  role   = "roles/storage.objectViewer"
  member = google_service_account.github_staging_relay_deploy[0].member

  condition {
    title       = "relay_staging_deploy_state"
    description = "Limits the staging Relay deploy workflows to the default Terraform state and lock."
    expression = join(" || ", [
      "resource.name == 'projects/_/buckets/${var.project_id}-terraform-state/objects/terraform/state/default.tfstate'",
      "resource.name == 'projects/_/buckets/${var.project_id}-terraform-state/objects/terraform/state/default.tflock'"
    ])
  }
}

# Deploy Relay Staging step "Require the mirrored immutable image" runs
# `gcloud artifacts docker images describe`; nothing in the five writes to the repository.
resource "google_artifact_registry_repository_iam_member" "github_staging_relay_deploy_artifact_reader" {
  count = local.create_staging_relay_deploy_identity ? 1 : 0

  project    = var.project_id
  location   = var.region
  repository = var.artifact_repository_id
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.github_staging_relay_deploy[0].member
}

# Deploy Relay Staging step "Deploy director blue/green", Operate Relay Asia Admission step
# "Deploy the registered additive director topology", and Power Relay Staging's scale-to-zero all
# drive `gcloud run services update|update-traffic` against the staging director.
resource "google_cloud_run_v2_service_iam_member" "github_staging_relay_deploy_director_developer" {
  count = local.create_staging_relay_deploy_identity ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = var.relay_cloud_run_service_name
  role     = "roles/run.developer"
  member   = google_service_account.github_staging_relay_deploy[0].member
}

# Power Relay Staging step "Inspect or change staging power state" scales both entries of
# CLOUD_RUN_SERVICES in power-staging-relay.mjs to zero, and the second one is the shared staging
# auth service. The same workflow already stops the shared staging database through
# orcaRelayStagingPower, so this stays with the power operator rather than the apps root.
resource "google_cloud_run_v2_service_iam_member" "github_staging_relay_deploy_auth_developer" {
  count = local.create_staging_relay_deploy_identity && var.relay_staging_power_auth_service_name != "" ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = var.relay_staging_power_auth_service_name
  role     = "roles/run.developer"
  member   = google_service_account.github_staging_relay_deploy[0].member
}

# That same scale-to-zero mints a revision when the latest ready one is not already at zero, and
# Cloud Run gates a revision on actAs over the service's runtime account.
resource "google_service_account_iam_member" "github_staging_relay_deploy_auth_runtime_user" {
  count = local.create_staging_relay_deploy_identity && var.relay_staging_power_auth_service_name != "" ? 1 : 0

  service_account_id = "projects/${var.project_id}/serviceAccounts/${local.staging_auth_runtime_service_account_email}"
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.github_staging_relay_deploy[0].member
}

# Deploy Relay Staging GCE Candidate preflight reads MIG, instance, and backend-service topology
# (deploy-relay-gce-candidate.mjs inspectCell), which the power role's instanceGroupManagers.get
# does not cover.
resource "google_project_iam_member" "github_staging_relay_deploy_compute_viewer" {
  count = local.create_staging_relay_deploy_identity ? 1 : 0

  project = var.project_id
  role    = "roles/compute.viewer"
  member  = google_service_account.github_staging_relay_deploy[0].member
}
