# Runtime switch files: cells/<cellId>.json read by each cell, written only by the one-cell
# flag workflow. The cell image derives the name from
# the metadata server's project id, so it must stay "<project_id>-relay-control".
#
# Apply only with the targeted command in the PR that added this file; a root plan rolls the
# fleet. Nothing here touches a template, MIG or service.
resource "google_storage_bucket" "relay_control" {
  project  = var.project_id
  name     = "${var.project_id}-relay-control"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  # Every write is a new generation, so the object history is the audit trail.
  versioning {
    enabled = true
  }

  # The writer needs delete to overwrite, and delete also reaches old generations. Soft delete
  # keeps any deleted generation recoverable for 90 days (the GCS maximum), so a mistaken or
  # hostile delete cannot erase the trail inside that window.
  soft_delete_policy {
    retention_duration_seconds = 7776000
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 365
    }
    action {
      type = "Delete"
    }
  }

  labels = {
    environment = var.environment
    service     = "relay"
  }
}

# Cells share one runtime account, so IAM cannot scope a cell to its own object; the image
# reads only cells/<its cellId>.json, and read access grants no control.
resource "google_storage_bucket_iam_member" "relay_control_cell_reader" {
  bucket = google_storage_bucket.relay_control.name
  role   = "roles/storage.objectViewer"
  member = google_service_account.relay_runtime.member
}

# Overwrite and nothing more: no list, no ACL or bucket permissions. GCS needs delete to
# replace a live object even with versioning on.
resource "google_project_iam_custom_role" "relay_control_writer" {
  count = local.relay_create_github_deploy_identity ? 1 : 0

  project     = var.project_id
  role_id     = "orcaRelayControlWriter"
  title       = "Orca Relay control writer"
  description = "Reads and overwrites relay runtime switch objects."
  permissions = ["storage.objects.create", "storage.objects.delete", "storage.objects.get"]
}

# The flag workflow's identity, the only writer. The deploy account is shared with every relay
# deploy workflow, so the grant reaches only the per-cell objects.
resource "google_storage_bucket_iam_member" "relay_control_workflow_writer" {
  count = local.relay_create_github_deploy_identity ? 1 : 0

  bucket = google_storage_bucket.relay_control.name
  role   = google_project_iam_custom_role.relay_control_writer[0].id
  member = local.relay_github_deploy_service_account_member

  condition {
    title       = "relay_control_cell_objects"
    description = "Limits the deploy identity to cells/<cellId>.json."
    expression  = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.relay_control.name}/objects/cells/')"
  }
}
