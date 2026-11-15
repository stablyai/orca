output "secrets_kms_key" {
  description = "Worker var SECRETS_KMS_KEY."
  value       = google_kms_crypto_key.kek_wrap.id
}

output "worker_service_account" {
  description = "Create its key with gcloud and pipe it into the Worker secret SECRETS_KMS_SERVICE_ACCOUNT."
  value       = google_service_account.worker.email
}

output "kek_escrow_secret" {
  value = google_secret_manager_secret.kek_escrow.id
}
