# GitHub Actions identities the relay root owns.
#
# The shared deploy account, its Workload Identity provider, and everything bound to it are
# environment-conditional under amendment A1: production is relay-owned, staging is apps-owned.
# Both state surgeries are done, so their counts are production-only here; the staging copies
# are declared by infra/terraform-apps and live in its state.
#
# The Workload Identity pool itself is foundation-owned and reached by literal through
# relay-shared.tf, never by reference.

locals {
  github_monitor_caller_workflow_file = "monitor-relay-production.yml"
  github_monitor_workflow_file        = "monitor-relay-production-job.yml"
  github_fence_workflow_file          = "deploy-relay-production-multi-target.yml"
  github_production_relay_workflow_files = [
    "deploy-relay-fence-broker.yml",
    "deploy-relay-production-capacity.yml",
    "deploy-relay-production-director.yml",
    "deploy-relay-production-multi-target.yml",
    "deploy-relay-production.yml",
    "operate-relay-asia-admission.yml",
    "publish-relay-production.yml"
  ]
  github_production_relay_capacity_workflow_file     = "deploy-relay-production-capacity.yml"
  github_production_relay_capacity_job_workflow_file = "deploy-relay-production-capacity-job.yml"
  github_production_relay_same_cap_workflow_file     = "deploy-relay-production-same-cap.yml"
  github_production_relay_same_cap_job_workflow_file = "deploy-relay-production-same-cap-job.yml"
  github_production_relay_rehome_workflow_file       = "operate-relay-production-rehome.yml"
  github_production_relay_rehome_job_workflow_file   = "operate-relay-production-rehome-job.yml"
  github_staging_relay_capacity_workflow_files = [
    "bootstrap-relay-staging-capacity.yml",
    "prove-relay-staging-capacity.yml",
    "recover-relay-staging-c4-image.yml"
  ]

  # The same-cap caller admits its own jobs too: release_lease runs in the caller file and presents
  # the caller as job_workflow_ref, so pinning only the reusable job would refuse it.
  github_production_relay_workflow_clauses = [
    for prefix in local.relay_github_workflow_ref_prefixes :
    "((${join(" || ", [for workflow_file in local.github_production_relay_workflow_files : "assertion.workflow_ref == '${prefix}${workflow_file}@refs/heads/main'"])}) || (assertion.workflow_ref == '${prefix}${local.github_production_relay_rehome_workflow_file}@refs/heads/main' && assertion.job_workflow_ref == '${prefix}${local.github_production_relay_rehome_job_workflow_file}@refs/heads/main') || (assertion.workflow_ref == '${prefix}${local.github_production_relay_same_cap_workflow_file}@refs/heads/main' && (assertion.job_workflow_ref == '${prefix}${local.github_production_relay_same_cap_job_workflow_file}@refs/heads/main' || assertion.job_workflow_ref == '${prefix}${local.github_production_relay_same_cap_workflow_file}@refs/heads/main')))"
  ]
  github_monitor_workflow_clauses = [
    for prefix in local.relay_github_workflow_ref_prefixes :
    "assertion.workflow_ref == '${prefix}${local.github_monitor_caller_workflow_file}@refs/heads/main' && assertion.job_workflow_ref == '${prefix}${local.github_monitor_workflow_file}@refs/heads/main'"
  ]
  github_fence_workflow_clauses = [
    for prefix in local.relay_github_workflow_ref_prefixes :
    "assertion.workflow_ref == '${prefix}${local.github_fence_workflow_file}@refs/heads/main' && assertion.job_workflow_ref == '${prefix}${local.github_fence_workflow_file}@refs/heads/main'"
  ]
  github_production_relay_capacity_workflow_clauses = [
    for prefix in local.relay_github_workflow_ref_prefixes :
    "((assertion.workflow_ref == '${prefix}${local.github_production_relay_capacity_workflow_file}@refs/heads/main' && assertion.job_workflow_ref == '${prefix}${local.github_production_relay_capacity_job_workflow_file}@refs/heads/main') || (assertion.workflow_ref == '${prefix}${local.github_production_relay_same_cap_workflow_file}@refs/heads/main' && assertion.job_workflow_ref == '${prefix}${local.github_production_relay_same_cap_job_workflow_file}@refs/heads/main'))"
  ]
  github_staging_relay_capacity_workflow_clauses = [
    for prefix in local.relay_github_workflow_ref_prefixes :
    "(${join(" || ", [for workflow_file in local.github_staging_relay_capacity_workflow_files : "assertion.workflow_ref == '${prefix}${workflow_file}@refs/heads/main'"])})"
  ]

  create_staging_relay_power_role = (
    local.relay_create_github_deploy_identity && var.environment == "staging"
  )
  create_staging_relay_capacity_identity = (
    local.relay_create_github_deploy_identity && var.environment == "staging"
  )
  create_production_relay_capacity_identity = (
    local.relay_create_github_deploy_identity && var.environment == "production"
  )
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project                            = var.project_id
  workload_identity_pool_id          = local.relay_workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub"

  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.actor"               = "assertion.actor"
    "attribute.environment"         = "assertion.environment"
    "attribute.ref"                 = "assertion.ref"
    "attribute.repository"          = "assertion.repository"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.workflow_ref"        = "assertion.workflow_ref"
  }

  # Production-only, so the condition is unconditional. The staging copy of this provider is
  # declared by infra/terraform-apps/github-actions.tf and pinned there.
  attribute_condition = join(" && ", concat(local.relay_github_leading_repository_claims, [
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == 'production'",
    local.relay_github_workflow_conditions["github"]
  ]))

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_iam_workload_identity_pool_provider" "github_monitor" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project                            = var.project_id
  workload_identity_pool_id          = local.relay_workload_identity_pool_id
  workload_identity_pool_provider_id = "github-relay-monitor"
  display_name                       = "GitHub Relay production monitor"

  attribute_mapping = {
    "google.subject"               = "assertion.sub"
    "attribute.repository"         = "assertion.repository"
    "attribute.ref"                = "assertion.ref"
    "attribute.environment"        = "assertion.environment"
    "attribute.job_workflow_ref"   = "assertion.job_workflow_ref"
    "attribute.relay_ops_identity" = "'monitor'"
  }

  attribute_condition = join(" && ", concat(local.relay_github_leading_repository_claims, [
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == 'production'",
    local.relay_github_workflow_conditions["github_monitor"]
  ]))

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_iam_workload_identity_pool_provider" "github_fence" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project                            = var.project_id
  workload_identity_pool_id          = local.relay_workload_identity_pool_id
  workload_identity_pool_provider_id = "github-relay-fence"
  display_name                       = "GitHub Relay production fence"

  attribute_mapping = {
    "google.subject"               = "assertion.sub"
    "attribute.repository"         = "assertion.repository"
    "attribute.ref"                = "assertion.ref"
    "attribute.environment"        = "assertion.environment"
    "attribute.job_workflow_ref"   = "assertion.job_workflow_ref"
    "attribute.relay_ops_identity" = "'fence'"
  }

  attribute_condition = join(" && ", concat(local.relay_github_leading_repository_claims, [
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == 'production'",
    local.relay_github_workflow_conditions["github_fence"]
  ]))

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_iam_workload_identity_pool_provider" "github_staging_relay_capacity" {
  count = local.create_staging_relay_capacity_identity ? 1 : 0

  project                            = var.project_id
  workload_identity_pool_id          = local.relay_workload_identity_pool_id
  workload_identity_pool_provider_id = "github-relay-capacity"
  display_name                       = "GitHub Relay staging capacity"

  attribute_mapping = {
    "google.subject"               = "assertion.sub"
    "attribute.repository"         = "assertion.repository"
    "attribute.ref"                = "assertion.ref"
    "attribute.environment"        = "assertion.environment"
    "attribute.workflow_ref"       = "assertion.workflow_ref"
    "attribute.relay_ops_identity" = "'staging-capacity'"
  }

  attribute_condition = join(" && ", concat(local.relay_github_leading_repository_claims, [
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == 'staging'",
    local.relay_github_workflow_conditions["github_staging_relay_capacity"]
  ]))

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_iam_workload_identity_pool_provider" "github_production_relay_capacity" {
  count = local.create_production_relay_capacity_identity ? 1 : 0

  project                            = var.project_id
  workload_identity_pool_id          = local.relay_workload_identity_pool_id
  workload_identity_pool_provider_id = "github-relay-capacity"
  display_name                       = "GitHub Relay production capacity"

  attribute_mapping = {
    "google.subject"               = "assertion.sub"
    "attribute.repository"         = "assertion.repository"
    "attribute.ref"                = "assertion.ref"
    "attribute.environment"        = "assertion.environment"
    "attribute.workflow_ref"       = "assertion.workflow_ref"
    "attribute.job_workflow_ref"   = "assertion.job_workflow_ref"
    "attribute.relay_ops_identity" = "'production-capacity'"
  }

  attribute_condition = join(" && ", concat(local.relay_github_leading_repository_claims, [
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == 'production'",
    local.relay_github_workflow_conditions["github_production_relay_capacity"]
  ]))

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "github_deploy" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-gha-deploy"
  display_name = "Orca Cloud GitHub deploy"
  description  = "Deploys Orca Cloud from GitHub Actions."
}

resource "google_service_account" "github_monitor" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-gha-monitor"
  display_name = "Orca Relay production monitor"
  description  = "Reads aggregate Relay production telemetry."
}

resource "google_service_account" "github_fence" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-gha-fence"
  display_name = "Orca Relay production fence requester"
  description  = "Requests exact reviewed Relay cell fences through the private broker."
}

resource "google_service_account" "github_staging_relay_capacity" {
  count = local.create_staging_relay_capacity_identity ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-gha-cap"
  display_name = "Orca Relay staging capacity transition"
  description  = "Runs the exact reviewed Relay staging capacity workflow."
}

resource "google_service_account" "github_production_relay_capacity" {
  count = local.create_production_relay_capacity_identity ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-gha-cap"
  display_name = "Orca Relay production capacity transition"
  description  = "Runs the exact reviewed Relay production capacity workflow."
}

resource "google_service_account_iam_member" "github_workload_identity_user" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  service_account_id = google_service_account.github_deploy[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.relay_workload_identity_pool_name}/attribute.repository/${local.relay_github_repository}"
}

# The `github` provider maps assertion.repository straight through, so the binding above admits
# only the primary repository. Each additional accepted repository needs its own principalSet
# before its workflows can mint this account; with an empty list this creates nothing.
resource "google_service_account_iam_member" "github_accepted_repository_workload_identity_user" {
  for_each = toset(
    local.relay_create_production_ops_identity
    ? slice(local.relay_github_accepted_repository_names, 1, length(local.relay_github_accepted_repository_names))
    : []
  )

  service_account_id = google_service_account.github_deploy[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.relay_workload_identity_pool_name}/attribute.repository/${each.key}"
}

resource "google_service_account_iam_member" "github_monitor_workload_identity_user" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  service_account_id = google_service_account.github_monitor[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.relay_workload_identity_pool_name}/attribute.relay_ops_identity/monitor"
}

resource "google_service_account_iam_member" "github_fence_workload_identity_user" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  service_account_id = google_service_account.github_fence[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.relay_workload_identity_pool_name}/attribute.relay_ops_identity/fence"
}

resource "google_service_account_iam_member" "github_staging_relay_capacity_workload_identity_user" {
  count = local.create_staging_relay_capacity_identity ? 1 : 0

  service_account_id = google_service_account.github_staging_relay_capacity[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.relay_workload_identity_pool_name}/attribute.relay_ops_identity/staging-capacity"
}

resource "google_service_account_iam_member" "github_production_relay_capacity_workload_identity_user" {
  count = local.create_production_relay_capacity_identity ? 1 : 0

  service_account_id = google_service_account.github_production_relay_capacity[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.relay_workload_identity_pool_name}/attribute.relay_ops_identity/production-capacity"
}

resource "google_artifact_registry_repository_iam_member" "github_production_relay_writer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project    = var.project_id
  location   = var.region
  repository = var.artifact_repository_id
  role       = "roles/artifactregistry.writer"
  member     = local.relay_github_deploy_service_account_member
}

resource "google_artifact_registry_repository_iam_member" "github_production_relay_staging_mirror_writer" {
  count = local.relay_create_github_deploy_identity && var.environment == "staging" ? 1 : 0

  project    = var.project_id
  location   = var.region
  repository = var.artifact_repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:orca-cloud-gha-deploy@onorca-cloud.iam.gserviceaccount.com"
}

resource "google_cloud_run_v2_service_iam_member" "github_production_relay_director_developer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = var.relay_cloud_run_service_name
  role     = "roles/run.developer"
  member   = local.relay_github_deploy_service_account_member
}

resource "google_cloud_run_v2_service_iam_member" "github_production_relay_fence_broker_developer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = var.relay_fence_broker_service_name
  role     = "roles/run.developer"
  member   = local.relay_github_deploy_service_account_member
}

# Candidate preflight reads GCE/LB topology; Terraform fencing keeps mutation narrowly scoped.
resource "google_project_iam_member" "github_compute_viewer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project = var.project_id
  role    = "roles/compute.viewer"
  member  = google_service_account.github_deploy[0].member
}

# Incident monitoring needs aggregate telemetry and inventory without mutation permissions.
resource "google_project_iam_member" "github_monitoring_viewer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project = var.project_id
  role    = "roles/monitoring.viewer"
  member  = google_service_account.github_deploy[0].member
}

resource "google_project_iam_member" "github_logging_viewer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project = var.project_id
  role    = "roles/logging.viewer"
  member  = google_service_account.github_deploy[0].member
}

resource "google_project_iam_member" "github_cloudsql_viewer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.viewer"
  member  = google_service_account.github_deploy[0].member
}

resource "google_project_iam_member" "github_relay_monitor_monitoring_viewer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project = var.project_id
  role    = "roles/monitoring.viewer"
  member  = google_service_account.github_monitor[0].member
}

resource "google_project_iam_member" "github_relay_monitor_logging_viewer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project = var.project_id
  role    = "roles/logging.viewer"
  member  = google_service_account.github_monitor[0].member
}

resource "google_project_iam_member" "github_relay_monitor_cloudsql_viewer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.viewer"
  member  = google_service_account.github_monitor[0].member
}

resource "google_project_iam_member" "github_monitor_compute_viewer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project = var.project_id
  role    = "roles/compute.viewer"
  member  = google_service_account.github_monitor[0].member
}

resource "google_project_iam_member" "github_fence_monitoring_viewer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project = var.project_id
  role    = "roles/monitoring.viewer"
  member  = google_service_account.github_fence[0].member
}

resource "google_project_iam_member" "github_fence_logging_viewer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project = var.project_id
  role    = "roles/logging.viewer"
  member  = google_service_account.github_fence[0].member
}

resource "google_project_iam_member" "github_fence_cloudsql_viewer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.viewer"
  member  = google_service_account.github_fence[0].member
}

resource "google_project_iam_member" "github_fence_compute_viewer" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  project = var.project_id
  role    = "roles/compute.viewer"
  member  = google_service_account.github_fence[0].member
}

# Staging may sleep between test windows. Keep its workflow narrower than a
# general Compute/Cloud SQL editor and never create this role in production.
resource "google_project_iam_custom_role" "github_staging_relay_power" {
  count = local.create_staging_relay_power_role ? 1 : 0

  project     = var.project_id
  role_id     = "orcaRelayStagingPower"
  title       = "Orca Relay staging power operator"
  description = "Scales staging Relay MIGs and starts or stops its shared staging database."
  permissions = [
    "cloudsql.instances.get",
    "cloudsql.instances.update",
    "cloudsql.operations.get",
    "compute.instanceGroupManagers.get",
    "compute.instanceGroupManagers.update",
    "compute.zoneOperations.get"
  ]
}

resource "google_project_iam_member" "github_staging_relay_power" {
  count = local.create_staging_relay_power_role ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.github_staging_relay_power[0].id
  member  = local.relay_github_deploy_service_account_member
}

resource "google_project_iam_custom_role" "github_staging_relay_capacity_mutation" {
  count = local.create_staging_relay_capacity_identity ? 1 : 0

  project     = var.project_id
  role_id     = "orcaRelayStagingCapacity"
  title       = "Orca Relay staging capacity transition"
  description = "Replaces one staging Relay template and restarts its managed instance group."
  permissions = [
    "compute.disks.create",
    "compute.healthChecks.use",
    "compute.images.useReadOnly",
    "compute.instanceGroupManagers.get",
    "compute.instanceGroupManagers.update",
    "compute.instances.create",
    "compute.instances.setLabels",
    "compute.instances.setMetadata",
    "compute.instances.setTags",
    "compute.instanceTemplates.create",
    "compute.instanceTemplates.delete",
    "compute.instanceTemplates.get",
    "compute.instanceTemplates.useReadOnly",
    "compute.networks.use",
    "compute.subnetworks.use",
    "compute.zoneOperations.get"
  ]
}

resource "google_project_iam_member" "github_staging_relay_capacity_mutation" {
  count = local.create_staging_relay_capacity_identity ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.github_staging_relay_capacity_mutation[0].id
  member  = google_service_account.github_staging_relay_capacity[0].member
}

resource "google_project_iam_member" "github_staging_relay_capacity_viewer" {
  count = local.create_staging_relay_capacity_identity ? 1 : 0

  project = var.project_id
  role    = "roles/viewer"
  member  = google_service_account.github_staging_relay_capacity[0].member
}

resource "google_project_iam_member" "github_staging_relay_capacity_artifact_reader" {
  count = local.create_staging_relay_capacity_identity ? 1 : 0

  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = google_service_account.github_staging_relay_capacity[0].member
}

resource "google_cloud_run_v2_service_iam_member" "github_staging_relay_capacity_developer" {
  count = local.create_staging_relay_capacity_identity ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = var.relay_cloud_run_service_name
  role     = "roles/run.developer"
  member   = google_service_account.github_staging_relay_capacity[0].member
}

resource "google_storage_bucket_iam_member" "github_staging_relay_capacity_state" {
  count = local.create_staging_relay_capacity_identity ? 1 : 0

  bucket = "${var.project_id}-terraform-state"
  role   = "roles/storage.objectAdmin"
  member = google_service_account.github_staging_relay_capacity[0].member

  condition {
    title       = "relay_capacity_state"
    description = "Limits the staging capacity workflow to the default Terraform state and lock."
    expression = join(" || ", [
      "resource.name == 'projects/_/buckets/${var.project_id}-terraform-state/objects/terraform/state/default.tfstate'",
      "resource.name == 'projects/_/buckets/${var.project_id}-terraform-state/objects/terraform/state/default.tflock'"
    ])
  }
}

resource "google_service_account_iam_member" "github_staging_relay_capacity_runtime_user" {
  count = local.create_staging_relay_capacity_identity ? 1 : 0

  service_account_id = google_service_account.relay_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.github_staging_relay_capacity[0].member
}

resource "google_project_iam_custom_role" "github_production_relay_capacity_mutation" {
  count = local.create_production_relay_capacity_identity ? 1 : 0

  project     = var.project_id
  role_id     = "orcaRelayProductionCapacity"
  title       = "Orca Relay production capacity transition"
  description = "Replaces exactly one production Relay template and its managed instance."
  permissions = [
    "compute.disks.create",
    "compute.healthChecks.use",
    "compute.images.useReadOnly",
    "compute.instanceGroupManagers.get",
    "compute.instanceGroupManagers.update",
    "compute.instances.create",
    "compute.instances.setLabels",
    "compute.instances.setMetadata",
    "compute.instances.setTags",
    "compute.instanceTemplates.create",
    "compute.instanceTemplates.delete",
    "compute.instanceTemplates.get",
    "compute.instanceTemplates.useReadOnly",
    "compute.networks.use",
    "compute.subnetworks.use",
    "compute.zoneOperations.get"
  ]
}

resource "google_project_iam_member" "github_production_relay_capacity_mutation" {
  count = local.create_production_relay_capacity_identity ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.github_production_relay_capacity_mutation[0].id
  member  = google_service_account.github_production_relay_capacity[0].member
}

resource "google_project_iam_member" "github_production_relay_capacity_viewer" {
  count = local.create_production_relay_capacity_identity ? 1 : 0

  project = var.project_id
  role    = "roles/viewer"
  member  = google_service_account.github_production_relay_capacity[0].member
}

resource "google_project_iam_member" "github_production_relay_capacity_artifact_reader" {
  count = local.create_production_relay_capacity_identity ? 1 : 0

  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = google_service_account.github_production_relay_capacity[0].member
}

resource "google_storage_bucket_iam_member" "github_production_relay_capacity_state" {
  count = local.create_production_relay_capacity_identity ? 1 : 0

  bucket = "${var.project_id}-terraform-state"
  role   = "roles/storage.objectAdmin"
  member = google_service_account.github_production_relay_capacity[0].member

  condition {
    title       = "relay_production_capacity_state"
    description = "Limits the production capacity workflow to the default Terraform state and lock."
    expression = join(" || ", [
      "resource.name == 'projects/_/buckets/${var.project_id}-terraform-state/objects/terraform/state/default.tfstate'",
      "resource.name == 'projects/_/buckets/${var.project_id}-terraform-state/objects/terraform/state/default.tflock'"
    ])
  }
}

resource "google_service_account_iam_member" "github_production_relay_capacity_runtime_user" {
  count = local.create_production_relay_capacity_identity ? 1 : 0

  service_account_id = google_service_account.relay_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.github_production_relay_capacity[0].member
}

# Candidate preflight reads reviewed Terraform outputs, but must not be able to mutate state.
resource "google_storage_bucket_iam_member" "github_terraform_state_reader" {
  count = local.relay_create_production_ops_identity ? 1 : 0

  bucket = "${var.project_id}-terraform-state"
  role   = "roles/storage.objectViewer"
  member = google_service_account.github_deploy[0].member
}


# Relay deploys replace only the image while retaining the Terraform-owned
# runtime identity and service shape.
resource "google_service_account_iam_member" "github_relay_runtime_service_account_user" {
  count = local.relay_create_github_deploy_identity ? 1 : 0

  service_account_id = google_service_account.relay_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.relay_github_deploy_service_account_member
}

resource "google_service_account_iam_member" "github_relay_director_runtime_service_account_user" {
  count = local.relay_create_github_deploy_identity ? 1 : 0

  service_account_id = google_service_account.relay_director_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.relay_github_deploy_service_account_member
}

