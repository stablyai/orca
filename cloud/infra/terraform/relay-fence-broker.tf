locals {
  create_relay_fence_broker = local.relay_create_production_ops_identity
  relay_fence_state_bucket  = "${var.project_id}-terraform-state"
  relay_fence_state_prefix  = "projects/_/buckets/${local.relay_fence_state_bucket}/objects/terraform/state"
}

resource "google_service_account" "relay_fence_broker" {
  count = local.create_relay_fence_broker ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-relay-fence"
  display_name = "Orca Relay fence broker"
  description  = "Owns exact reviewed Terraform cell fences behind an authenticated broker."
}

resource "google_project_iam_custom_role" "relay_fence_broker_mutation" {
  count = local.create_relay_fence_broker ? 1 : 0

  project     = var.project_id
  role_id     = "orcaRelayFenceBroker"
  title       = "Orca Relay fence broker"
  description = "Updates only reviewed Relay MIG sizes and inspects their zone operations."
  permissions = [
    "compute.instanceGroupManagers.update"
  ]
}

resource "google_project_iam_member" "relay_fence_broker_mutation" {
  count = local.create_relay_fence_broker ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.relay_fence_broker_mutation[0].id
  member  = google_service_account.relay_fence_broker[0].member
}

resource "google_project_iam_member" "relay_fence_broker_compute_viewer" {
  count = local.create_relay_fence_broker ? 1 : 0

  project = var.project_id
  role    = "roles/compute.viewer"
  member  = google_service_account.relay_fence_broker[0].member
}

resource "google_project_iam_member" "relay_fence_broker_logging_viewer" {
  count = local.create_relay_fence_broker ? 1 : 0

  project = var.project_id
  role    = "roles/logging.viewer"
  member  = google_service_account.relay_fence_broker[0].member
}

resource "google_project_iam_member" "relay_fence_broker_artifact_reader" {
  count = local.create_relay_fence_broker ? 1 : 0

  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = google_service_account.relay_fence_broker[0].member
}

resource "google_storage_bucket_iam_member" "relay_fence_broker_bucket_reader" {
  count = local.create_relay_fence_broker ? 1 : 0

  bucket = local.relay_fence_state_bucket
  role   = "roles/storage.legacyBucketReader"
  member = google_service_account.relay_fence_broker[0].member
}

resource "google_storage_bucket_iam_member" "relay_fence_broker_state_objects" {
  count = local.create_relay_fence_broker ? 1 : 0

  bucket = local.relay_fence_state_bucket
  role   = "roles/storage.objectAdmin"
  member = google_service_account.relay_fence_broker[0].member

  condition {
    title       = "relay_fence_exact_objects"
    description = "Main state, private saved plans, and the durable broker lease only."
    expression = join(" || ", [
      "resource.name.startsWith('${local.relay_fence_state_prefix}/default')",
      "resource.name.startsWith('${local.relay_fence_state_prefix}/relay-fence-plans/production/')",
      "resource.name.startsWith('${local.relay_fence_state_prefix}/relay-fence-broker/')"
    ])
  }
}

resource "google_service_account_iam_member" "relay_fence_broker_requester_token_creator" {
  count = local.create_relay_fence_broker ? 1 : 0

  service_account_id = google_service_account.github_fence[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = google_service_account.relay_fence_broker[0].member
}

resource "google_service_account_iam_member" "github_relay_fence_broker_service_account_user" {
  count = local.create_relay_fence_broker ? 1 : 0

  service_account_id = google_service_account.relay_fence_broker[0].name
  role               = "roles/iam.serviceAccountUser"
  member             = local.relay_github_deploy_service_account_member
}

resource "google_cloud_run_v2_service" "relay_fence_broker" {
  count = local.create_relay_fence_broker ? 1 : 0

  project             = var.project_id
  name                = var.relay_fence_broker_service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.environment == "production"
  labels              = local.relay_shared_labels

  template {
    service_account                  = google_service_account.relay_fence_broker[0].email
    timeout                          = "1800s"
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = var.relay_fence_broker_image

      ports {
        container_port = 8080
      }

      env {
        name  = "ORCA_RELAY_FENCE_PROJECT"
        value = var.project_id
      }

      env {
        name  = "ORCA_RELAY_FENCE_STATE_BUCKET"
        value = local.relay_fence_state_bucket
      }

      env {
        name  = "ORCA_RELAY_FENCE_LEASE_OBJECT"
        value = "terraform/state/relay-fence-broker/production.lock"
      }

      env {
        name  = "ORCA_RELAY_FENCE_DIRECTOR_ORIGIN"
        value = var.relay_base_url
      }

      env {
        name  = "ORCA_RELAY_FENCE_ADMIN_AUDIENCE"
        value = "${var.relay_base_url}/v1/admin/drain"
      }

      env {
        name  = "ORCA_RELAY_FENCE_REQUESTER_SERVICE_ACCOUNT"
        value = google_service_account.github_fence[0].email
      }

      env {
        name  = "ORCA_RELAY_FENCE_RUNTIME_SERVICE_ACCOUNT"
        value = google_service_account.relay_runtime.email
      }

      env {
        name  = "ORCA_RELAY_FENCE_SOURCE_CELL_ID"
        value = var.relay_fence_source_cell_id
      }

      env {
        name  = "ORCA_RELAY_FENCE_FAILED_TARGET_CELL_ID"
        value = var.relay_fence_failed_target_cell_id
      }

      env {
        name  = "ORCA_RELAY_FENCE_REPLACEMENT_TARGET_CELL_ID"
        value = var.relay_fence_replacement_target_cell_id
      }

      env {
        name  = "ORCA_RELAY_FENCE_UNOBSERVED_CONNECTION_BOUND"
        value = tostring(var.relay_fence_unobserved_connection_bound)
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }

        cpu_idle = false
      }

      startup_probe {
        failure_threshold     = 12
        initial_delay_seconds = 0
        period_seconds        = 5
        timeout_seconds       = 2

        http_get {
          path = "/healthz"
          port = 8080
        }
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
    google_project_iam_member.relay_fence_broker_artifact_reader,
    google_project_iam_member.relay_fence_broker_compute_viewer,
    google_project_iam_member.relay_fence_broker_logging_viewer,
    google_project_iam_member.relay_fence_broker_mutation,
    google_storage_bucket_iam_member.relay_fence_broker_bucket_reader,
    google_storage_bucket_iam_member.relay_fence_broker_state_objects
  ]
}

resource "google_cloud_run_v2_service_iam_member" "relay_fence_broker_invoker" {
  count = local.create_relay_fence_broker ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.relay_fence_broker[0].name
  role     = "roles/run.invoker"
  member   = google_service_account.github_fence[0].member
}

resource "google_cloud_run_v2_service_iam_member" "relay_fence_broker_deploy_invoker" {
  count = local.create_relay_fence_broker ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.relay_fence_broker[0].name
  role     = "roles/run.invoker"
  member   = local.relay_github_deploy_service_account_member
}
