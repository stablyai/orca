locals {
  # Deployment uses its own production-only identity.
  push_gateway_deploy_count = (
    var.push_gateway_enabled && local.relay_create_production_ops_identity ? 1 : 0
  )
  github_push_workflow_clauses = [
    for prefix in local.relay_github_workflow_ref_prefixes :
    "assertion.workflow_ref == '${prefix}push-deploy.yml@refs/heads/main' && assertion.job_workflow_ref == '${prefix}push-deploy.yml@refs/heads/main'"
  ]
  push_deploy_member = one(google_service_account.github_push_deploy[*].member)
}

resource "google_service_account" "github_push_deploy" {
  count        = local.push_gateway_deploy_count
  account_id   = "${var.name_prefix}-gha-push"
  display_name = "Orca push production deploy"
}

resource "google_iam_workload_identity_pool_provider" "github_push" {
  count = local.push_gateway_deploy_count

  project                            = var.project_id
  workload_identity_pool_id          = local.relay_workload_identity_pool_id
  workload_identity_pool_provider_id = "github-push-deploy"
  display_name                       = "GitHub push production deploy"
  # Do not map attribute.repository: that principal set can assume the shared deploy account.
  attribute_mapping = {
    "google.subject"        = "assertion.sub"
    "attribute.push_deploy" = "'production'"
  }
  attribute_condition = join(" && ", concat(local.relay_github_leading_repository_claims, [
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == 'production'",
    "assertion.event_name == 'workflow_dispatch'",
    local.relay_github_workflow_conditions["github_push"]
  ]))

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_push_workload_identity_user" {
  count = local.push_gateway_deploy_count

  service_account_id = google_service_account.github_push_deploy[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.relay_workload_identity_pool_name}/attribute.push_deploy/production"
}

resource "google_artifact_registry_repository_iam_member" "github_push_artifact_writer" {
  count = local.push_gateway_deploy_count

  project    = var.project_id
  location   = var.region
  repository = var.artifact_repository_id
  role       = "roles/artifactregistry.writer"
  member     = local.push_deploy_member
}

output "github_push_workload_identity_provider" {
  value = try(google_iam_workload_identity_pool_provider.github_push[0].name, null)
}

output "github_push_deploy_service_account" {
  value = try(google_service_account.github_push_deploy[0].email, null)
}


resource "google_storage_bucket_iam_member" "github_push_rollout_lease" {
  count = local.push_gateway_deploy_count

  bucket = "${var.project_id}-terraform-state"
  role   = "roles/storage.objectAdmin"
  member = local.push_deploy_member

  condition {
    title       = "push_rollout_lease"
    description = "Limits push deployment coordination to its own lease object."
    expression  = "resource.name == 'projects/_/buckets/${var.project_id}-terraform-state/objects/terraform/state/push-rollout/production.lock'"
  }
}
