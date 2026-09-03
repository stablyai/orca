# Values the relay root shares with the foundation and apps roots, expressed as literals or
# data lookups so the relay never references another root's resources. Every literal here
# renders byte-identically to the resource attribute it replaces; the partition test pins that.
locals {
  relay_shared_labels = {
    app         = "orca-cloud"
    environment = var.environment
    managed_by  = "terraform"
  }
  relay_github_repository = "${var.github_owner}/${var.github_repo}"
  relay_github_repository_claims = [
    "assertion.repository == '${local.relay_github_repository}'",
    "assertion.repository_id == '${var.github_repo_id}'",
    "assertion.repository_owner_id == '${var.github_owner_id}'",
  ]

  # Dual accept during the public extraction: the primary repository first, then every repository
  # var.github_accepted_repositories adds. Each one renders its own OR arm in every provider
  # condition, so both repos can run the same workflows through the same identities. A repository
  # that imports these workflows may rename the files, hence the per-repository prefix.
  relay_github_accepted_repositories = concat([{
    owner                = var.github_owner
    repo                 = var.github_repo
    repo_id              = var.github_repo_id
    owner_id             = var.github_owner_id
    workflow_file_prefix = ""
  }], var.github_accepted_repositories)

  relay_github_single_repository = length(local.relay_github_accepted_repositories) == 1

  relay_github_accepted_repository_names = [
    for repository in local.relay_github_accepted_repositories :
    "${repository.owner}/${repository.repo}"
  ]

  # Everything before the workflow file name, per accepted repository.
  relay_github_workflow_ref_prefixes = [
    for repository in local.relay_github_accepted_repositories :
    "${repository.owner}/${repository.repo}/.github/workflows/${repository.workflow_file_prefix}"
  ]

  # The three repository claims as one conjunction, per accepted repository, for the OR arms.
  relay_github_accepted_repository_claims = [
    for repository in local.relay_github_accepted_repositories :
    join(" && ", [
      "assertion.repository == '${repository.owner}/${repository.repo}'",
      "assertion.repository_id == '${repository.repo_id}'",
      "assertion.repository_owner_id == '${repository.owner_id}'"
    ])
  ]

  # With one accepted repository the claims lead each condition exactly as they always have. With
  # more they move inside the arms, because a leading claim would contradict the other arm.
  relay_github_leading_repository_claims = (
    local.relay_github_single_repository ? local.relay_github_repository_claims : []
  )

  relay_create_github_deploy_identity  = var.github_owner != "" && var.github_repo != ""
  relay_create_production_ops_identity = local.relay_create_github_deploy_identity && var.environment == "production"

  # google_service_account.github_deploy lives in the relay root in production and in the apps
  # root in staging, so its email is derived rather than read, matching the runtime accounts above.
  # Staging Relay workflows authenticate as the relay-owned github_staging_relay_deploy account
  # instead, so every relay binding, the cell startup metadata, and the director env follow it.
  relay_github_deploy_service_account_email = (
    var.environment == "production"
    ? "${var.name_prefix}-gha-deploy@${var.project_id}.iam.gserviceaccount.com"
    : "${var.name_prefix}-gha-relay@${var.project_id}.iam.gserviceaccount.com"
  )
  relay_github_deploy_service_account_member = "serviceAccount:${local.relay_github_deploy_service_account_email}"

  relay_workload_identity_pool_id   = "${var.name_prefix}-github"
  relay_workload_identity_pool_name = "projects/${data.google_project.relay.number}/locations/global/workloadIdentityPools/${local.relay_workload_identity_pool_id}"

  # Cloud SQL instance is foundation-owned; cell plans already derive the connection name so
  # they stay independent of database drift.
  relay_database_instance_name   = "${var.name_prefix}-auth-db"
  relay_database_connection_name = "${var.project_id}:${var.region}:${local.relay_database_instance_name}"
}

data "google_project" "relay" {
  project_id = var.project_id
}

# Existence checks only: nothing in a plan value depends on these reads.
data "google_artifact_registry_repository" "relay_images" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_repository_id
}
