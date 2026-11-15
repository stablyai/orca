output "relay_url" {
  description = "CHATGPT_RELAY_URL for the sandbox-control Worker."
  value       = var.image == "" ? null : google_cloud_run_v2_service.relay[0].uri
}

output "image_repository" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.relay.repository_id}"
}

output "invoker_service_account" {
  value = google_service_account.invoker.email
}
