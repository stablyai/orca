resource "google_service_account" "relay_runtime" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-relay"
  display_name = var.environment == "staging" ? "Orca Relay" : "Orca Relay cells"
  description = var.environment == "staging" ? (
    "Runtime identity for the Orca Relay director and stamped cells."
  ) : "Runtime identity for stamped Orca Relay cells."
}

resource "google_service_account" "relay_director_runtime" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-relay-dir"
  display_name = "Orca Relay director"
  description  = "Runtime and regional rehoming caller identity for the Orca Relay director."
}

resource "google_project_iam_member" "relay_runtime_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = google_service_account.relay_runtime.member
}

resource "google_project_iam_member" "relay_director_runtime_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = google_service_account.relay_director_runtime.member
}

resource "random_password" "relay_assignment_signing_key" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "relay_assignment_signing_key" {
  project   = var.project_id
  secret_id = "orca-cloud-relay-assignment-signing-key"
  labels    = local.relay_shared_labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "relay_assignment_signing_key" {
  secret      = google_secret_manager_secret.relay_assignment_signing_key.id
  secret_data = random_password.relay_assignment_signing_key.result
}

resource "google_secret_manager_secret_iam_member" "relay_assignment_signing_key_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.relay_assignment_signing_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.relay_runtime.member
}

resource "google_secret_manager_secret_iam_member" "relay_assignment_signing_key_director_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.relay_assignment_signing_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.relay_director_runtime.member
}

resource "google_secret_manager_secret" "relay_regional_placement_enabled" {
  project   = var.project_id
  secret_id = "orca-cloud-relay-regional-placement-enabled"
  labels    = local.relay_shared_labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "relay_regional_placement_enabled" {
  secret      = google_secret_manager_secret.relay_regional_placement_enabled.id
  secret_data = tostring(var.relay_regional_placement_enabled)
}

resource "google_secret_manager_secret_iam_member" "relay_regional_placement_runtime_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.relay_regional_placement_enabled.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.relay_runtime.member
}

resource "google_secret_manager_secret_iam_member" "relay_regional_placement_director_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.relay_regional_placement_enabled.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.relay_director_runtime.member
}

resource "google_secret_manager_secret_iam_member" "relay_regional_placement_deploy_accessor" {
  count = local.relay_create_github_deploy_identity ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.relay_regional_placement_enabled.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.relay_github_deploy_service_account_member
}

resource "google_secret_manager_secret_iam_member" "relay_regional_placement_deploy_adder" {
  count = local.relay_create_github_deploy_identity ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.relay_regional_placement_enabled.secret_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = local.relay_github_deploy_service_account_member
}

resource "google_secret_manager_secret_iam_member" "relay_regional_placement_deploy_viewer" {
  count = local.relay_create_github_deploy_identity ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.relay_regional_placement_enabled.secret_id
  role      = "roles/secretmanager.viewer"
  member    = local.relay_github_deploy_service_account_member
}

data "external" "relay_serving_regional_placement_version" {
  program = [
    "node",
    "${path.module}/../../dev/scripts/read-relay-serving-regional-placement-version.mjs"
  ]
  query = {
    project           = var.project_id
    region            = var.region
    service           = var.relay_cloud_run_service_name
    bootstrap_version = google_secret_manager_secret_version.relay_regional_placement_enabled.version
  }
}

resource "google_cloud_run_v2_service" "relay" {
  project              = var.project_id
  name                 = var.relay_cloud_run_service_name
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true
  labels               = local.relay_shared_labels

  template {
    service_account                  = google_service_account.relay_director_runtime.email
    timeout                          = "${var.relay_director_request_timeout_seconds}s"
    max_instance_request_concurrency = var.relay_director_concurrency

    scaling {
      min_instance_count = var.relay_min_instances
      max_instance_count = var.relay_max_instances
    }

    volumes {
      name = "cloudsql"

      cloud_sql_instance {
        instances = [local.relay_database_connection_name]
      }
    }

    containers {
      image = var.relay_cloud_run_image

      env {
        name = "ORCA_RELAY_REGIONAL_PLACEMENT_ENABLED"

        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.relay_regional_placement_enabled.secret_id
            version = data.external.relay_serving_regional_placement_version.result.version
          }
        }
      }

      ports {
        container_port = 8080
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name = "DATABASE_URL"

        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.relay_database_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "ORCA_RELAY_ASSIGNMENT_SIGNING_KEY"

        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.relay_assignment_signing_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "ORCA_RELAY_PUBLIC_URL"
        value = var.relay_base_url
      }

      env {
        name  = "ORCA_RELAY_CELL_URL"
        value = var.relay_base_url
      }

      env {
        name  = "ORCA_RELAY_AUTH_ISSUER"
        value = var.auth_base_url
      }

      env {
        name  = "ORCA_RELAY_AUTH_AUDIENCE"
        value = "orca-relay"
      }

      env {
        name  = "ORCA_RELAY_JWKS_URL"
        value = "${var.auth_base_url}/.well-known/jwks.json"
      }

      env {
        name  = "ORCA_RELAY_ROLE"
        value = "director"
      }

      env {
        name  = "ORCA_RELAY_ADMISSION_SELECTOR_VERSION"
        value = "3"
      }

      env {
        name  = "ORCA_RELAY_CELL_ID"
        value = "director"
      }

      env {
        name  = "ORCA_RELAY_CELLS_JSON"
        value = local.relay_director_cells_json
      }

      env {
        name  = "ORCA_RELAY_ADMIN_AUDIENCE"
        value = "${var.relay_base_url}/v1/admin/drain"
      }

      env {
        name  = "ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT"
        value = local.relay_github_deploy_service_account_email
      }

      env {
        name  = "ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT"
        value = local.relay_capacity_service_account_email
      }

      env {
        name  = "ORCA_RELAY_ASIA_PROOF_SERVICE_ACCOUNT"
        value = local.relay_asia_proof_service_account_email
      }

      env {
        name  = "ORCA_RELAY_MONITOR_SERVICE_ACCOUNT"
        value = try(google_service_account.github_monitor[0].email, "")
      }

      env {
        name  = "ORCA_RELAY_FENCE_SERVICE_ACCOUNT"
        value = try(google_service_account.github_fence[0].email, "")
      }

      env {
        name  = "ORCA_RELAY_FENCE_BROKER_SERVICE_ACCOUNT"
        value = try(google_service_account.relay_fence_broker[0].email, "")
      }

      env {
        name  = "ORCA_RELAY_RUNTIME_SERVICE_ACCOUNT"
        value = google_service_account.relay_runtime.email
      }

      env {
        name  = "ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT"
        value = google_service_account.relay_director_runtime.email
      }

      env {
        name  = "ORCA_RELAY_REHOME_AUDIENCE"
        value = "${var.relay_base_url}/v1/admin/host-drain"
      }

      env {
        name  = "ORCA_RELAY_HEARTBEAT_AUDIENCE"
        value = "${var.relay_base_url}/v1/admin/cell-heartbeat"
      }

      env {
        name  = "ORCA_RELAY_PUBLIC_ASSIGNMENTS_ENABLED"
        value = tostring(var.relay_public_assignments_enabled)
      }

      env {
        name  = "ORCA_RELAY_PUBLIC_ASSIGNMENT_CONCURRENCY"
        value = tostring(var.relay_public_assignment_concurrency)
      }

      env {
        name  = "ORCA_RELAY_PUBLIC_ASSIGNMENT_RETRY_AFTER_SECONDS"
        value = tostring(var.relay_public_assignment_retry_after_seconds)
      }

      env {
        name  = "ORCA_RELAY_PUBLIC_ASSIGNMENT_QUEUE_MAX"
        value = tostring(var.relay_public_assignment_queue_max)
      }

      env {
        name  = "ORCA_RELAY_PUBLIC_ASSIGNMENT_WAIT_MS"
        value = tostring(var.relay_public_assignment_wait_ms)
      }

      env {
        name  = "ORCA_RELAY_DATABASE_POOL_MAX"
        value = tostring(var.relay_director_database_pool_max)
      }

      env {
        name  = "ORCA_RELAY_PUBLIC_STICKY_CONCURRENCY"
        value = tostring(var.relay_public_sticky_concurrency)
      }

      env {
        name  = "ORCA_RELAY_PUBLIC_STICKY_QUEUE_MAX"
        value = tostring(var.relay_public_sticky_queue_max)
      }

      env {
        name  = "ORCA_RELAY_PUBLIC_STICKY_WAIT_MS"
        value = tostring(var.relay_public_sticky_wait_ms)
      }

      env {
        name  = "ORCA_RELAY_PUBLIC_STICKY_RETRY_AFTER_SECONDS"
        value = tostring(var.relay_public_sticky_retry_after_seconds)
      }

      resources {
        limits = {
          cpu    = var.relay_cloud_run_cpu
          memory = var.relay_cloud_run_memory
        }

        cpu_idle = false
      }
    }
  }

  # Deploys update immutable images; Terraform owns service shape and IAM.
  lifecycle {
    # Why: the relay refuses to boot unless both admission lanes fit the pool, so catch it
    # at plan time rather than as a crash loop on the candidate revision.
    precondition {
      condition = (var.relay_public_assignment_concurrency +
      var.relay_public_sticky_concurrency) <= var.relay_director_database_pool_max
      error_message = "Placement plus reconnect admission must fit the director database pool."
    }

    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image
    ]
  }

  depends_on = [
    data.google_artifact_registry_repository.relay_images,
    google_project_iam_member.relay_director_runtime_cloudsql_client,
    google_secret_manager_secret_iam_member.relay_assignment_signing_key_director_accessor,
    google_secret_manager_secret_iam_member.relay_regional_placement_director_accessor,
    google_secret_manager_secret_iam_member.relay_database_url_director_accessor,
    google_secret_manager_secret_version.relay_assignment_signing_key,
    google_secret_manager_secret_version.relay_regional_placement_enabled,
    google_secret_manager_secret_version.relay_database_url
  ]
}

resource "google_cloud_run_v2_service" "relay_cell" {
  for_each = var.relay_cells

  project              = var.project_id
  name                 = each.value.service_name
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true
  # Require an explicit configuration change before a stamped cell can be decommissioned.
  deletion_protection = each.value.deletion_protection
  labels = merge(local.relay_shared_labels, {
    "orca-relay-role" = "cell"
    "orca-relay-cell" = each.key
  })

  template {
    service_account                  = google_service_account.relay_runtime.email
    timeout                          = "${var.relay_request_timeout_seconds}s"
    max_instance_request_concurrency = var.relay_concurrency

    scaling {
      min_instance_count = each.value.min_instances
      max_instance_count = each.value.max_instances
    }

    volumes {
      name = "cloudsql"

      cloud_sql_instance {
        instances = [local.relay_database_connection_name]
      }
    }

    containers {
      image = var.relay_cloud_run_image

      ports {
        container_port = 8080
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name = "DATABASE_URL"

        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.relay_database_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "ORCA_RELAY_ASSIGNMENT_SIGNING_KEY"

        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.relay_assignment_signing_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "ORCA_RELAY_PUBLIC_URL"
        value = each.value.url
      }

      env {
        name  = "ORCA_RELAY_CELL_URL"
        value = each.value.url
      }

      env {
        name  = "ORCA_RELAY_AUTH_ISSUER"
        value = var.auth_base_url
      }

      env {
        name  = "ORCA_RELAY_AUTH_AUDIENCE"
        value = "orca-relay"
      }

      env {
        name  = "ORCA_RELAY_JWKS_URL"
        value = "${var.auth_base_url}/.well-known/jwks.json"
      }

      env {
        name  = "ORCA_RELAY_ROLE"
        value = "cell"
      }

      env {
        name  = "ORCA_RELAY_CELL_ID"
        value = each.key
      }

      env {
        name  = "ORCA_RELAY_CELL_CAPACITY"
        value = tostring(each.value.capacity_requests)
      }

      env {
        name  = "ORCA_RELAY_CELLS_JSON"
        value = "[]"
      }

      env {
        name  = "ORCA_RELAY_ADMIN_AUDIENCE"
        value = "${var.relay_base_url}/v1/admin/drain"
      }

      env {
        name  = "ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT"
        value = local.relay_github_deploy_service_account_email
      }

      env {
        name  = "ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT"
        value = local.relay_capacity_service_account_email
      }

      env {
        name  = "ORCA_RELAY_ASIA_PROOF_SERVICE_ACCOUNT"
        value = local.relay_asia_proof_service_account_email
      }

      env {
        name  = "ORCA_RELAY_RUNTIME_SERVICE_ACCOUNT"
        value = google_service_account.relay_runtime.email
      }

      env {
        name  = "ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT"
        value = contains(var.relay_region_rehome_source_cell_ids, each.key) ? google_service_account.relay_director_runtime.email : ""
      }

      env {
        name  = "ORCA_RELAY_REHOME_AUDIENCE"
        value = contains(var.relay_region_rehome_source_cell_ids, each.key) ? "${var.relay_base_url}/v1/admin/host-drain" : ""
      }

      env {
        name  = "ORCA_RELAY_DIRECTOR_URL"
        value = var.relay_base_url
      }

      env {
        name  = "ORCA_RELAY_HEARTBEAT_AUDIENCE"
        value = "${var.relay_base_url}/v1/admin/cell-heartbeat"
      }

      resources {
        limits = {
          cpu    = var.relay_cloud_run_cpu
          memory = var.relay_cloud_run_memory
        }

        cpu_idle = false
      }
    }
  }

  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image
    ]
  }

  depends_on = [
    data.google_artifact_registry_repository.relay_images,
    google_project_iam_member.relay_runtime_cloudsql_client,
    google_secret_manager_secret_iam_member.relay_assignment_signing_key_accessor,
    google_secret_manager_secret_iam_member.relay_database_url_accessor,
    google_secret_manager_secret_version.relay_assignment_signing_key,
    google_secret_manager_secret_version.relay_database_url
  ]
}
