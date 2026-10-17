# Step 4: the relay's own Cloud SQL instance, so relay load can no longer starve sign-in on the
# shared auth instance. Data moves with the restart-free move tool (database-move-cli.ts); nothing
# here changes the shared instance except adding the tool's own login, orca_relay_move.
#
# Apply only with the targeted command in the PR that added this file; a root plan rolls the fleet.
locals {
  relay_dedicated_database_count = var.relay_dedicated_database_enabled ? 1 : 0
}

resource "google_sql_database_instance" "relay_dedicated" {
  count = local.relay_dedicated_database_count

  project             = var.project_id
  name                = coalesce(var.relay_dedicated_database_name, "${var.name_prefix}-relay-db")
  region              = var.region
  database_version    = "POSTGRES_17"
  deletion_protection = true

  settings {
    # Enterprise Plus: planned maintenance and scale-up drop connections for under a second, so the
    # relay's own database adds no maintenance outages of its own.
    tier              = var.relay_dedicated_database_tier
    edition           = var.relay_dedicated_database_edition
    availability_type = "REGIONAL"
    disk_type         = "PD_SSD"
    disk_size         = 50
    disk_autoresize   = true
    user_labels       = local.relay_shared_labels

    # Unset lets Cloud SQL pick; set it when a zone is out of Enterprise Plus capacity.
    dynamic "location_preference" {
      for_each = var.relay_dedicated_database_zone == null ? [] : [1]
      content {
        zone           = var.relay_dedicated_database_zone
        secondary_zone = var.relay_dedicated_database_secondary_zone
      }
    }

    # Explicit, because the tier default moves with memory; the relay's worst case is ~350.
    database_flags {
      name  = "max_connections"
      value = "500"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      start_time                     = "07:00"
      # Enterprise Plus refuses retained backups at or below the log retention days.
      backup_retention_settings {
        retained_backups = 14
      }
    }

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    # Not the shared instance's Sunday 00:00Z, so one window never hits both services.
    maintenance_window {
      day          = 3
      hour         = 9
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled = true
      query_string_length    = 1024
    }

    deletion_protection_enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_sql_database" "relay_dedicated" {
  count = local.relay_dedicated_database_count

  project  = var.project_id
  name     = "orca_relay"
  instance = google_sql_database_instance.relay_dedicated[0].name

  lifecycle {
    prevent_destroy = true
  }
}

resource "random_password" "relay_dedicated_database" {
  count   = local.relay_dedicated_database_count
  length  = 32
  special = false
}

resource "google_sql_user" "relay_dedicated" {
  count = local.relay_dedicated_database_count

  project  = var.project_id
  name     = "orca_relay"
  instance = google_sql_database_instance.relay_dedicated[0].name
  password = random_password.relay_dedicated_database[0].result
}

# The move tool's login on each side. Its writes are skipped by the change-tracking triggers, and
# the fence (a password change on orca_relay) never locks it out, so it can sync in either direction.
resource "random_password" "relay_move_primary" {
  count   = local.relay_dedicated_database_count
  length  = 32
  special = false
}

resource "google_sql_user" "relay_move_primary" {
  count = local.relay_dedicated_database_count

  project  = var.project_id
  name     = "orca_relay_move"
  instance = local.relay_database_instance_name
  password = random_password.relay_move_primary[0].result
}

resource "random_password" "relay_move_dedicated" {
  count   = local.relay_dedicated_database_count
  length  = 32
  special = false
}

resource "google_sql_user" "relay_move_dedicated" {
  count = local.relay_dedicated_database_count

  project  = var.project_id
  name     = "orca_relay_move"
  instance = google_sql_database_instance.relay_dedicated[0].name
  password = random_password.relay_move_dedicated[0].result
}

locals {
  relay_dedicated_database_secrets = var.relay_dedicated_database_enabled ? {
    "relay-dedicated-database-url" = {
      user       = google_sql_user.relay_dedicated[0].name
      password   = random_password.relay_dedicated_database[0].result
      connection = google_sql_database_instance.relay_dedicated[0].connection_name
    }
    "relay-move-primary-database-url" = {
      user       = google_sql_user.relay_move_primary[0].name
      password   = random_password.relay_move_primary[0].result
      connection = local.relay_database_connection_name
    }
    "relay-move-dedicated-database-url" = {
      user       = google_sql_user.relay_move_dedicated[0].name
      password   = random_password.relay_move_dedicated[0].result
      connection = google_sql_database_instance.relay_dedicated[0].connection_name
    }
  } : {}
}

resource "google_secret_manager_secret" "relay_dedicated_database" {
  for_each = local.relay_dedicated_database_secrets

  project   = var.project_id
  secret_id = "${var.name_prefix}-${each.key}"
  labels    = local.relay_shared_labels

  replication {
    auto {}
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret_version" "relay_dedicated_database" {
  for_each = local.relay_dedicated_database_secrets

  secret = google_secret_manager_secret.relay_dedicated_database[each.key].id
  secret_data = format(
    "postgresql://%s:%s@/orca_relay?host=/cloudsql/%s",
    each.value.user,
    each.value.password,
    each.value.connection
  )
}

# Cells and directors read only the app URL; only the move job reads the move URLs.
resource "google_secret_manager_secret_iam_member" "relay_dedicated_database_url_accessor" {
  for_each = var.relay_dedicated_database_enabled ? {
    cells     = google_service_account.relay_runtime.member
    directors = google_service_account.relay_director_runtime.member
    move      = google_service_account.relay_database_move[0].member
  } : {}

  project   = var.project_id
  secret_id = google_secret_manager_secret.relay_dedicated_database["relay-dedicated-database-url"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}

# Directors find the dedicated instance through the same pointer object the cells read.
resource "google_storage_bucket_iam_member" "relay_control_director_pointer_reader" {
  count = local.relay_dedicated_database_count

  bucket = google_storage_bucket.relay_control.name
  role   = "roles/storage.objectViewer"
  member = google_service_account.relay_director_runtime.member

  condition {
    title       = "relay_database_target_pointer"
    description = "Limits directors to database-target.json."
    expression  = "resource.name == 'projects/_/buckets/${google_storage_bucket.relay_control.name}/objects/database-target.json'"
  }
}

# The move job: a Cloud Run job on the relay image, run by an operator for each step.
resource "google_service_account" "relay_database_move" {
  count = local.relay_dedicated_database_count

  project      = var.project_id
  account_id   = "${var.name_prefix}-rdbmove"
  display_name = "Orca Relay database move job"
}

resource "google_secret_manager_secret_iam_member" "relay_database_move_accessor" {
  for_each = var.relay_dedicated_database_enabled ? {
    primary_app    = google_secret_manager_secret.relay_database_url.secret_id
    primary_move   = google_secret_manager_secret.relay_dedicated_database["relay-move-primary-database-url"].secret_id
    dedicated_move = google_secret_manager_secret.relay_dedicated_database["relay-move-dedicated-database-url"].secret_id
  } : {}

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.relay_database_move[0].member
}

resource "google_project_iam_member" "relay_database_move_cloudsql_client" {
  count = local.relay_dedicated_database_count

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = google_service_account.relay_database_move[0].member
}

# restore-password resets orca_relay from its secret after a fence; nothing broader.
resource "google_project_iam_custom_role" "relay_database_move_password" {
  count = local.relay_dedicated_database_count

  project     = var.project_id
  role_id     = "orcaRelayDatabaseMovePassword"
  title       = "Orca Relay database move password reset"
  description = "Resets the relay login's password on the shared and dedicated instances."
  permissions = ["cloudsql.instances.get", "cloudsql.users.list", "cloudsql.users.update"]
}

resource "google_project_iam_member" "relay_database_move_password" {
  count = local.relay_dedicated_database_count

  # Project-wide: Cloud SQL users.update refused (403) with a resource.name condition on staging.
  project = var.project_id
  role    = google_project_iam_custom_role.relay_database_move_password[0].id
  member  = google_service_account.relay_database_move[0].member
}

# The cutover writes the quiesce window into the pointer, and nothing else in the bucket.
resource "google_storage_bucket_iam_member" "relay_control_move_pointer_writer" {
  count = local.relay_dedicated_database_count

  bucket = google_storage_bucket.relay_control.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.relay_database_move[0].member

  condition {
    title       = "relay_database_target_pointer"
    description = "Limits the move job to database-target.json."
    expression  = "resource.name == 'projects/_/buckets/${google_storage_bucket.relay_control.name}/objects/database-target.json'"
  }
}
