# SEC-3 phase 1: the Cloud KMS key that wraps the sandbox-control secret store's KEK, the service
# account the Worker uses to unwrap it, and the break-glass escrow of the KEK itself.
# Own root and state (backend prefix terraform/secrets-kms) so applies of other roots can never plan
# to destroy the key: a destroyed key version makes every stored secret unreadable.
# Runbook: .context/cloud/reports/secrets-kms-runbook.md. Worker config: sc/src/env.ts (SECRETS_KMS_*).
# Nothing secret is in this root or its state: the KEK is generated straight into the escrow secret
# with gcloud, and the service-account key is created with gcloud and piped into the Worker secret.

locals {
  labels = {
    app         = "orca-cloud"
    component   = "sandbox-secrets"
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "google_project_service" "kms" {
  project            = var.project_id
  service            = "cloudkms.googleapis.com"
  disable_on_destroy = false
}

resource "google_kms_key_ring" "secrets" {
  project  = var.project_id
  name     = "orca-secrets"
  location = var.location

  depends_on = [google_project_service.kms]
}

resource "google_kms_crypto_key" "kek_wrap" {
  name                       = "secrets-kek"
  key_ring                   = google_kms_key_ring.secrets.id
  purpose                    = "ENCRYPT_DECRYPT"
  rotation_period            = var.rotation_period
  destroy_scheduled_duration = "2592000s" # 30 days to cancel a version destroy
  labels                     = local.labels

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account" "worker" {
  project      = var.project_id
  account_id   = "orca-sandbox-secrets"
  display_name = "sandbox-control secret store: KMS decrypt of the KEK only"
  description  = "Held by the sandbox-control Worker as SECRETS_KMS_SERVICE_ACCOUNT. Its only grant is decrypt on ${google_kms_crypto_key.kek_wrap.id}."
}

# The Worker's only permission anywhere: decrypt with this one key.
resource "google_kms_crypto_key_iam_member" "worker_decrypt" {
  crypto_key_id = google_kms_crypto_key.kek_wrap.id
  role          = "roles/cloudkms.cryptoKeyDecrypter"
  member        = "serviceAccount:${google_service_account.worker.email}"
}

# Data Access audit logs (off by default) so every decrypt and encrypt is logged. Audit config is
# per service and project; it cannot be scoped to one key.
resource "google_project_iam_audit_config" "kms" {
  project = var.project_id
  service = "cloudkms.googleapis.com"

  audit_log_config {
    log_type = "ADMIN_READ"
  }
  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

# Break-glass escrow: one version per KEK id (label the version with the id). Versions are added
# with `gcloud secrets versions add --data-file=-` from a pipe, never through Terraform.
resource "google_secret_manager_secret" "kek_escrow" {
  project   = var.project_id
  secret_id = "orca-cloud-sandbox-secrets-kek"
  labels    = local.labels

  replication {
    auto {}
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret_iam_member" "kek_escrow_readers" {
  for_each  = toset(var.escrow_readers)
  project   = var.project_id
  secret_id = google_secret_manager_secret.kek_escrow.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}

resource "google_project_iam_audit_config" "secret_manager" {
  project = var.project_id
  service = "secretmanager.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }
}
