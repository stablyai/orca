# Orca mobile push gateway (`cloud/apps/push`).
#
# One public Cloud Run service that holds the APNs key and sends through APNs and FCM V1 on
# behalf of paired phones. Contract: `docs/reference/mobile-push-contract.md`, "Infra" and
# "Gateway env". Operations: `docs/push-gateway.md`.
#
# There is no staging push gateway by decision, so every resource here is behind
# `var.push_gateway_enabled`, which only `environments/production.tfvars` sets true. The file
# still reads every environment-shaped value from a variable, like the rest of this root, so a
# future staging gateway is a tfvars edit rather than a rewrite.
#
# Several resources below already exist in `onorca-cloud`; they are declared so a plan is clean
# and imported once. `docs/push-gateway.md` carries the exact `terraform import` commands.

locals {
  push_gateway_count = var.push_gateway_enabled ? 1 : 0

  # The runtime account, the three provider secrets, and their accessor bindings already exist in
  # production and were created out of band with the Apple credentials.
  push_runtime_service_account_id = "${var.name_prefix}-push"

  # Secret Manager holds the Apple credentials. Terraform owns the secret names, labels, and
  # replication; it never owns a version. The `.p8` is issued by the Apple developer portal and
  # rotated by `docs/push-gateway.md`, so a Terraform-managed version would either put the key in
  # state or fight the rotation. `ignore_changes` on the whole resource is not available, so the
  # versions are simply not declared and every consumer reads `latest`.
  push_provider_secret_ids = var.push_gateway_enabled ? toset([
    "${var.name_prefix}-push-apns-key",
    "${var.name_prefix}-push-apns-key-id",
    "${var.name_prefix}-push-apple-team-id"
  ]) : toset([])

  push_provider_secret_env = {
    "${var.name_prefix}-push-apns-key"      = "ORCA_PUSH_APNS_KEY"
    "${var.name_prefix}-push-apns-key-id"   = "ORCA_PUSH_APNS_KEY_ID"
    "${var.name_prefix}-push-apple-team-id" = "ORCA_PUSH_APPLE_TEAM_ID"
  }

  push_fcm_project_id = var.push_fcm_project_id == "" ? var.project_id : var.push_fcm_project_id

  push_fqdn = replace(replace(var.push_base_url, "https://", ""), "http://", "")


}

# --- Runtime identity ---------------------------------------------------------------------

resource "google_service_account" "push_runtime" {
  count = local.push_gateway_count

  project      = var.project_id
  account_id   = local.push_runtime_service_account_id
  display_name = "Orca mobile push gateway"
  description  = "Runtime identity for the Orca mobile push gateway; sends through FCM V1."
}

# FCM V1 sends are authorized by the runtime account's own metadata-server token.
resource "google_project_iam_member" "push_runtime_fcm_admin" {
  count = local.push_gateway_count

  project = var.project_id
  role    = "roles/firebasecloudmessaging.admin"
  member  = google_service_account.push_runtime[0].member
}

# The FCM V1 endpoint bills against the caller's project quota, which the caller must consume.
resource "google_project_iam_member" "push_runtime_service_usage_consumer" {
  count = local.push_gateway_count

  project = var.project_id
  role    = "roles/serviceusage.serviceUsageConsumer"
  member  = google_service_account.push_runtime[0].member
}

resource "google_project_iam_member" "push_runtime_cloudsql_client" {
  count = local.push_gateway_count

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = google_service_account.push_runtime[0].member
}

# --- Apple credentials ----------------------------------------------------------------------

resource "google_secret_manager_secret" "push_provider" {
  for_each = local.push_provider_secret_ids

  project   = var.project_id
  secret_id = each.value
  labels    = local.relay_shared_labels

  replication {
    auto {}
  }

  # Why: Apple issues a `.p8` once and Secret Manager has no undelete. Turning the gateway off
  # must fail the plan rather than destroy the only copy of the signing key.
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret_iam_member" "push_provider_runtime_accessor" {
  for_each = local.push_provider_secret_ids

  project   = var.project_id
  secret_id = google_secret_manager_secret.push_provider[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.push_runtime[0].member
}

# --- Service --------------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "push" {
  count = local.push_gateway_count

  project  = var.project_id
  name     = var.push_cloud_run_service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  # Why: the host proof in `POST /v1/host/challenge` is the authentication, not Cloud Run IAM.
  # The project's domain-restricted-sharing policy refuses an `allUsers` invoker binding, so the
  # service opts out of invoker IAM exactly as the relay director does.
  invoker_iam_disabled = true
  deletion_protection  = var.environment == "production"
  labels               = local.relay_shared_labels

  template {
    service_account                  = google_service_account.push_runtime[0].email
    timeout                          = "${var.push_request_timeout_seconds}s"
    max_instance_request_concurrency = var.push_concurrency

    scaling {
      min_instance_count = var.push_min_instances
      max_instance_count = var.push_max_instances
    }

    volumes {
      name = "cloudsql"

      cloud_sql_instance {
        instances = [google_sql_database_instance.push_dedicated[0].connection_name]
      }
    }

    containers {
      image = var.push_cloud_run_image

      ports {
        container_port = 8080
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name  = "ORCA_PUSH_PUBLIC_URL"
        value = var.push_base_url
      }

      env {
        name  = "ORCA_PUSH_FCM_PROJECT_ID"
        value = local.push_fcm_project_id
      }

      # Bound the declared pool against the dedicated database rollout budget.
      env {
        name  = "ORCA_PUSH_DATABASE_POOL_MAX"
        value = tostring(var.push_database_pool_max)
      }

      env {
        name = "ORCA_PUSH_DATABASE_URL"

        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.push_dedicated_database_url[0].secret_id
            version = google_secret_manager_secret_version.push_dedicated_database_url[0].version
          }
        }
      }

      # Rotation adds a new version and redeploys; `latest` is what the redeploy picks up.
      dynamic "env" {
        for_each = local.push_provider_secret_env

        content {
          name = env.value

          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.push_provider[env.key].secret_id
              version = "latest"
            }
          }
        }
      }

      resources {
        limits = {
          cpu    = var.push_cloud_run_cpu
          memory = var.push_cloud_run_memory
        }

        cpu_idle = false
      }

      startup_probe {
        failure_threshold     = 12
        initial_delay_seconds = 0
        period_seconds        = 5
        timeout_seconds       = 2

        http_get {
          path = "/health"
          port = 8080
        }
      }
    }
  }

  # Deploys update the immutable image and shift traffic; Terraform owns the shape and IAM.
  #
  # `traffic` is ignored as well as the image. A deploy ends with traffic pinned to an exact
  # revision and a rollback pins it to the previous one; an apply that reset the service to
  # 100% LATEST would silently undo either, and this root carries unrelated standing drift, so
  # that apply need not be a push change at all.
  lifecycle {
    precondition {
      condition     = var.push_max_instances * var.push_database_pool_max * 3 <= 64
      error_message = "Dedicated push serving, validation/rejected and successor pools must fit the 64-connection rollout budget."
    }

    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image,
      traffic
    ]
  }

  depends_on = [
    data.google_artifact_registry_repository.relay_images,
    google_project_iam_member.push_runtime_cloudsql_client,
    google_secret_manager_secret_iam_member.push_provider_runtime_accessor,
    google_secret_manager_secret_version.push_dedicated_database_url,
    google_secret_manager_secret_iam_member.push_dedicated_database_url_accessor
  ]
}

# Google issues and renews the certificate for the mapping. The DNS record itself is a
# hand-managed Cloudflare CNAME to ghs.googlehosted.com, like relay.onorca.dev; this root has no
# Cloudflare surface by design. `terraform output push_dns_record` prints the record.
resource "google_cloud_run_domain_mapping" "push" {
  count = var.push_gateway_enabled && var.manage_push_domain_mapping ? 1 : 0

  location = var.region
  name     = local.push_fqdn

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.push[0].name
  }

  # Same reason as relay-dns.tf: a gcloud-created mapping reports an empty legacy
  # certificate_mode, and replacing it would reset issuance for no behavioral change.
  lifecycle {
    ignore_changes = [spec[0].certificate_mode]
  }
}

# --- Deploy identity grants -------------------------------------------------------------------
# Push deploy authority is isolated from Relay; foundation grants its rollout-lock access.

resource "google_cloud_run_v2_service_iam_member" "github_production_push_developer" {
  count = local.push_gateway_deploy_count

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.push[0].name
  role     = "roles/run.developer"
  member   = local.push_deploy_member
}

resource "google_service_account_iam_member" "github_production_push_runtime_user" {
  count = local.push_gateway_deploy_count

  service_account_id = google_service_account.push_runtime[0].name
  role               = "roles/iam.serviceAccountUser"
  member             = local.push_deploy_member
}

# Why: the deploy workflow's validate-only FCM send has to exercise the credential the gateway
# will actually use. Impersonating the runtime account proves its firebasecloudmessaging grant;
# granting the deploy account FCM admin outright would prove nothing about the runtime account
# and would widen a project-level role on the shared identity.
resource "google_service_account_iam_member" "github_production_push_runtime_token_creator" {
  count = local.push_gateway_deploy_count

  service_account_id = google_service_account.push_runtime[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.push_deploy_member
}
