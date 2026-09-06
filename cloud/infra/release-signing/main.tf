terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}
provider "google" {
  project = var.project
  region  = var.region
}
variable "project" { type = string }
variable "region" {
  type    = string
  default = "us-central1"
}
variable "image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Deploy an immutable coordinator image digest."
  }
}
variable "environment" {
  type = map(string)
  validation {
    condition     = alltrue([for key in keys(var.environment) : contains(["GITHUB_APP_ID", "GITHUB_INSTALLATION_ID", "SIGNPATH_ORGANIZATION_ID", "SIGNING_POLICIES"], key)])
    error_message = "Only public coordinator settings belong in environment; use Secret Manager for credentials."
  }
}
variable "secrets" {
  description = "Existing Secret Manager secret IDs, keyed by coordinator environment variable."
  type        = map(string)
  validation {
    condition     = toset(keys(var.secrets)) == toset(["GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "SIGNPATH_WEBHOOK_SECRET", "RECONCILE_SECRET", "SIGNPATH_API_TOKEN"])
    error_message = "Provide all five coordinator credentials as Secret Manager references."
  }
}
variable "reconcile_token" {
  type      = string
  sensitive = true
}
resource "google_service_account" "coordinator" {
  account_id   = "release-signing"
  display_name = "Windows release signing gates"
}
resource "google_secret_manager_secret_iam_member" "credentials" {
  for_each  = var.secrets
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.coordinator.email}"
}
resource "google_cloud_run_v2_service" "coordinator" {
  name     = "release-signing"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  template {
    service_account = google_service_account.coordinator.email
    timeout         = "300s"
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    containers {
      image = var.image
      resources { limits = { cpu = "1", memory = "256Mi" } }
      dynamic "env" {
        for_each = var.environment
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get { path = "/health" }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.credentials]
}
resource "google_cloud_run_v2_service_iam_member" "webhooks" {
  project  = var.project
  location = var.region
  name     = google_cloud_run_v2_service.coordinator.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
resource "google_cloud_scheduler_job" "reconcile" {
  name             = "release-signing-reconcile"
  schedule         = "*/5 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "300s"
  http_target {
    uri         = "${google_cloud_run_v2_service.coordinator.uri}/reconcile"
    http_method = "POST"
    headers     = { Authorization = "Bearer ${var.reconcile_token}" }
  }
  retry_config { retry_count = 3 }
}
output "url" { value = google_cloud_run_v2_service.coordinator.uri }
