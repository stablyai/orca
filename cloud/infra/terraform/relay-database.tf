# Relay credentials and assignment state share the existing Cloud SQL instance
# with auth, but use an isolated database and principal.
resource "google_sql_database" "relay" {
  project  = var.project_id
  name     = "orca_relay"
  instance = local.relay_database_instance_name
}

resource "random_password" "relay_database" {
  length  = 32
  special = false
}

resource "google_sql_user" "relay" {
  project  = var.project_id
  name     = "orca_relay"
  instance = local.relay_database_instance_name
  password = random_password.relay_database.result
}

resource "google_secret_manager_secret" "relay_database_url" {
  project   = var.project_id
  secret_id = "orca-cloud-relay-database-url"
  labels    = local.relay_shared_labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "relay_database_url" {
  secret = google_secret_manager_secret.relay_database_url.id
  secret_data = format(
    "postgresql://%s:%s@/%s?host=/cloudsql/%s",
    google_sql_user.relay.name,
    random_password.relay_database.result,
    google_sql_database.relay.name,
    local.relay_database_connection_name
  )
}

# The director's URL when it reaches Cloud SQL through its proxy sidecar. Cells keep the socket URL.
resource "google_secret_manager_secret" "relay_director_database_url" {
  count = var.relay_director_cloud_sql_proxy_sidecar ? 1 : 0

  project   = var.project_id
  secret_id = "orca-cloud-relay-director-database-url"
  labels    = local.relay_shared_labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "relay_director_database_url" {
  count = var.relay_director_cloud_sql_proxy_sidecar ? 1 : 0

  secret = google_secret_manager_secret.relay_director_database_url[0].id
  secret_data = format(
    "postgresql://%s:%s@127.0.0.1:5432/%s",
    google_sql_user.relay.name,
    random_password.relay_database.result,
    google_sql_database.relay.name
  )
}

resource "google_secret_manager_secret_iam_member" "relay_director_database_url_accessor" {
  count = var.relay_director_cloud_sql_proxy_sidecar ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.relay_director_database_url[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.relay_director_runtime.member
}

resource "google_secret_manager_secret_iam_member" "relay_database_url_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.relay_database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.relay_runtime.member
}

resource "google_secret_manager_secret_iam_member" "relay_database_url_director_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.relay_database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.relay_director_runtime.member
}
