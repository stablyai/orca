# The ChatGPT relay. chatgpt.com refuses Cloudflare Workers' egress, so the sandbox-control
# Worker's egress proxy sends chatgpt.com requests through this Cloud Run service (cloud/apps/chatgpt-relay).
# It forwards to chatgpt.com only, on the Codex paths the Worker allows, and streams the answers back.
# Only the invoker service account (held by the Worker as CHATGPT_RELAY_SERVICE_ACCOUNT) may call it.
# Own root and state (backend prefix terraform/chatgpt-relay). The invoker's key is created with gcloud and
# piped straight into the Worker secret: no key material in this root or its state.

locals {
  labels = {
    app         = "orca-cloud"
    component   = "chatgpt-relay"
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "google_project_service" "run" {
  project            = var.project_id
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifactregistry" {
  project            = var.project_id
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "relay" {
  project       = var.project_id
  location      = var.region
  repository_id = "orca-chatgpt-relay"
  format        = "DOCKER"
  labels        = local.labels

  depends_on = [google_project_service.artifactregistry]
}

# The service runs as an account with no grants: it needs nothing in Google Cloud.
resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "orca-chatgpt-relay"
  display_name = "ChatGPT relay runtime (no grants)"
}

resource "google_service_account" "invoker" {
  project      = var.project_id
  account_id   = "orca-chatgpt-relay-invoker"
  display_name = "sandbox-control Worker: run.invoker on the ChatGPT relay only"
  description  = "Held by the sandbox-control Worker as CHATGPT_RELAY_SERVICE_ACCOUNT. Its only grant is run.invoker on orca-chatgpt-relay."
}

resource "google_cloud_run_v2_service" "relay" {
  count    = var.image == "" ? 0 : 1
  project  = var.project_id
  name     = "orca-chatgpt-relay"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  labels   = local.labels

  deletion_protection = false

  template {
    service_account = google_service_account.runtime.email
    # Codex turns stream for minutes.
    timeout                          = "3600s"
    max_instance_request_concurrency = 80

    scaling {
      # One warm instance: a cold start cost Codex's first chatgpt.com call ~10.8 s (dev, twice on 2026-11-15).
      min_instance_count = 1
      max_instance_count = 4
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # SSE streams: keep CPU while a response is still being written.
        cpu_idle = false
      }

      startup_probe {
        http_get {
          path = "/health"
        }
      }
    }
  }

  depends_on = [google_project_service.run]
}

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  count    = var.image == "" ? 0 : 1
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.relay[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.invoker.email}"
}
