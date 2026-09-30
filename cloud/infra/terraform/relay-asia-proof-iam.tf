locals {
  create_relay_asia_proof_identity = (
    local.relay_create_github_deploy_identity && var.environment == "staging"
  )
  github_relay_asia_proof_workflow_file = "prove-relay-asia-staging.yml"
  github_relay_asia_proof_workflow_clauses = [
    for prefix in local.relay_github_workflow_ref_prefixes :
    "assertion.workflow_ref == '${prefix}${local.github_relay_asia_proof_workflow_file}@refs/heads/main'"
  ]
  relay_asia_proof_service_account_email = try(
    google_service_account.github_relay_asia_proof[0].email,
    ""
  )
}

resource "google_iam_workload_identity_pool_provider" "github_relay_asia_proof" {
  count = local.create_relay_asia_proof_identity ? 1 : 0

  project                            = var.project_id
  workload_identity_pool_id          = local.relay_workload_identity_pool_id
  workload_identity_pool_provider_id = "github-relay-asia-proof"
  display_name                       = "GitHub Relay Asia staging proof"

  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.environment"         = "assertion.environment"
    "attribute.event_name"          = "assertion.event_name"
    "attribute.ref"                 = "assertion.ref"
    "attribute.repository"          = "assertion.repository"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.workflow_ref"        = "assertion.workflow_ref"
    "attribute.relay_ops_identity"  = "'staging-asia-proof'"
  }

  attribute_condition = join(" && ", concat(local.relay_github_leading_repository_claims, [
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == 'staging'",
    "assertion.event_name == 'workflow_dispatch'",
    local.relay_github_workflow_conditions["github_relay_asia_proof"]
  ]))

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "github_relay_asia_proof" {
  count = local.create_relay_asia_proof_identity ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-gha-aproof"
  display_name = "Orca Relay Asia staging proof"
  description  = "Reads staging telemetry and performs only Relay's bounded Asia proof operations."
}

resource "google_service_account_iam_member" "github_relay_asia_proof_workload_identity_user" {
  count = local.create_relay_asia_proof_identity ? 1 : 0

  service_account_id = google_service_account.github_relay_asia_proof[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.relay_workload_identity_pool_name}/attribute.relay_ops_identity/staging-asia-proof"
}

resource "google_project_iam_member" "github_relay_asia_proof_logging_viewer" {
  count = local.create_relay_asia_proof_identity ? 1 : 0

  project = var.project_id
  role    = "roles/logging.viewer"
  member  = google_service_account.github_relay_asia_proof[0].member
}

resource "google_project_iam_member" "github_relay_asia_proof_monitoring_viewer" {
  count = local.create_relay_asia_proof_identity ? 1 : 0

  project = var.project_id
  role    = "roles/monitoring.viewer"
  member  = google_service_account.github_relay_asia_proof[0].member
}
