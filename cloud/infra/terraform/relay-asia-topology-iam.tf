locals {
  create_relay_asia_topology_identity      = local.relay_create_github_deploy_identity
  github_relay_asia_topology_workflow_file = "deploy-relay-asia-topology.yml"
  github_relay_asia_topology_workflow_clauses = [
    for prefix in local.relay_github_workflow_ref_prefixes :
    "assertion.workflow_ref == '${prefix}${local.github_relay_asia_topology_workflow_file}@refs/heads/main'"
  ]
}

resource "google_iam_workload_identity_pool_provider" "github_relay_asia_topology" {
  count = local.create_relay_asia_topology_identity ? 1 : 0

  project                            = var.project_id
  workload_identity_pool_id          = local.relay_workload_identity_pool_id
  workload_identity_pool_provider_id = "github-relay-asia"
  display_name                       = "GitHub Relay Asia topology"

  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.environment"         = "assertion.environment"
    "attribute.event_name"          = "assertion.event_name"
    "attribute.ref"                 = "assertion.ref"
    "attribute.repository"          = "assertion.repository"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.workflow_ref"        = "assertion.workflow_ref"
    "attribute.relay_ops_identity"  = "'${var.environment}-asia-topology'"
  }

  attribute_condition = join(" && ", concat(local.relay_github_leading_repository_claims, [
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == '${var.environment}'",
    "assertion.event_name == 'workflow_dispatch'",
    local.relay_github_workflow_conditions["github_relay_asia_topology"]
  ]))

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "github_relay_asia_topology" {
  count = local.create_relay_asia_topology_identity ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-gha-asia"
  display_name = "Orca Relay Asia topology"
  description  = "Applies only validated additive Relay Asia topology plans."
}

resource "google_service_account_iam_member" "github_relay_asia_topology_workload_identity_user" {
  count = local.create_relay_asia_topology_identity ? 1 : 0

  service_account_id = google_service_account.github_relay_asia_topology[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.relay_workload_identity_pool_name}/attribute.relay_ops_identity/${var.environment}-asia-topology"
}

resource "google_project_iam_custom_role" "github_relay_asia_topology_mutation" {
  count = local.create_relay_asia_topology_identity ? 1 : 0

  project     = var.project_id
  role_id     = "orcaRelayAsiaTopology"
  title       = "Orca Relay Asia topology"
  description = "Creates additive Relay Asia network and cell topology and updates its shared URL map."
  permissions = [
    "compute.backendServices.create",
    "compute.backendServices.get",
    "compute.backendServices.update",
    "compute.backendServices.use",
    "compute.disks.create",
    "compute.globalOperations.get",
    "compute.healthChecks.use",
    "compute.healthChecks.useReadOnly",
    "compute.images.useReadOnly",
    "compute.instanceGroupManagers.create",
    "compute.instanceGroupManagers.get",
    "compute.instanceGroupManagers.update",
    "compute.instanceGroups.create",
    "compute.instanceGroups.get",
    "compute.instanceGroups.use",
    "compute.instances.create",
    "compute.instances.setLabels",
    "compute.instances.setMetadata",
    "compute.instances.setTags",
    "compute.instances.use",
    "compute.instanceTemplates.create",
    "compute.instanceTemplates.get",
    "compute.instanceTemplates.useReadOnly",
    "compute.networks.get",
    "compute.networks.updatePolicy",
    "compute.networks.use",
    "compute.regionOperations.get",
    "compute.routers.create",
    "compute.routers.get",
    "compute.routers.update",
    "compute.subnetworks.create",
    "compute.subnetworks.get",
    "compute.subnetworks.setPrivateIpGoogleAccess",
    "compute.subnetworks.use",
    "compute.urlMaps.get",
    "compute.urlMaps.update",
    "compute.zoneOperations.get"
  ]
}

resource "google_project_iam_member" "github_relay_asia_topology_mutation" {
  count = local.create_relay_asia_topology_identity ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.github_relay_asia_topology_mutation[0].id
  member  = google_service_account.github_relay_asia_topology[0].member
}

resource "google_project_iam_custom_role" "github_relay_asia_topology_read" {
  count = local.create_relay_asia_topology_identity ? 1 : 0

  project     = var.project_id
  role_id     = "orcaRelayAsiaTopologyRead"
  title       = "Orca Relay Asia topology read"
  description = "Refreshes only resource types required by validated Relay Asia topology plans."
  permissions = [
    "artifactregistry.repositories.get",
    "cloudsql.instances.get",
    "compute.backendServices.get",
    "compute.healthChecks.get",
    "compute.instanceGroupManagers.get",
    "compute.instanceGroups.get",
    "compute.instanceTemplates.get",
    "compute.instances.get",
    "compute.networks.get",
    "compute.routers.get",
    "compute.subnetworks.get",
    "compute.urlMaps.get",
    "iam.serviceAccounts.get",
    "iam.serviceAccounts.getIamPolicy",
    "resourcemanager.projects.get",
    "resourcemanager.projects.getIamPolicy",
    "run.revisions.get",
    "run.services.get",
    "secretmanager.secrets.get",
    "secretmanager.secrets.getIamPolicy",
    "serviceusage.services.get",
    "serviceusage.services.list"
  ]
}

resource "google_project_iam_member" "github_relay_asia_topology_read" {
  count = local.create_relay_asia_topology_identity ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.github_relay_asia_topology_read[0].id
  member  = google_service_account.github_relay_asia_topology[0].member
}

resource "google_artifact_registry_repository_iam_member" "github_relay_asia_topology_artifact_reader" {
  count = local.create_relay_asia_topology_identity ? 1 : 0

  project    = var.project_id
  location   = var.region
  repository = var.artifact_repository_id
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.github_relay_asia_topology[0].member
}

resource "google_storage_bucket_iam_member" "github_relay_asia_topology_state" {
  count = local.create_relay_asia_topology_identity ? 1 : 0

  bucket = "${var.project_id}-terraform-state"
  role   = "roles/storage.objectAdmin"
  member = google_service_account.github_relay_asia_topology[0].member

  condition {
    title       = "relay_asia_topology_state"
    description = "Limits the Asia topology workflow to the environment Terraform state and lock."
    expression = join(" || ", [
      "resource.name == 'projects/_/buckets/${var.project_id}-terraform-state/objects/terraform/state/default.tfstate'",
      "resource.name == 'projects/_/buckets/${var.project_id}-terraform-state/objects/terraform/state/default.tflock'"
    ])
  }
}

resource "google_project_iam_custom_role" "github_relay_asia_topology_state_list" {
  count = local.create_relay_asia_topology_identity ? 1 : 0

  project     = var.project_id
  role_id     = "orcaRelayAsiaStateList"
  title       = "Orca Relay Asia state list"
  description = "Lists the environment state bucket so Terraform can initialize its backend."
  permissions = ["storage.objects.list"]
}

resource "google_storage_bucket_iam_member" "github_relay_asia_topology_state_list" {
  count = local.create_relay_asia_topology_identity ? 1 : 0

  bucket = "${var.project_id}-terraform-state"
  role   = google_project_iam_custom_role.github_relay_asia_topology_state_list[0].id
  member = google_service_account.github_relay_asia_topology[0].member
}

resource "google_service_account_iam_member" "github_relay_asia_topology_runtime_user" {
  count = local.create_relay_asia_topology_identity ? 1 : 0

  service_account_id = google_service_account.relay_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.github_relay_asia_topology[0].member
}
