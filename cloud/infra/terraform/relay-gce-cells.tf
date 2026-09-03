locals {
  relay_runtime_service_account_email          = "${var.name_prefix}-relay@${var.project_id}.iam.gserviceaccount.com"
  relay_director_runtime_service_account_email = "${var.name_prefix}-relay-dir@${var.project_id}.iam.gserviceaccount.com"
  relay_capacity_service_account_email = var.environment == "production" ? try(
    google_service_account.github_production_relay_capacity[0].email,
    ""
  ) : try(google_service_account.github_staging_relay_capacity[0].email, "")
  relay_gce_cells_enabled = local.relay_gce_configured && length(var.relay_gce_cells) > 0
  relay_gce_subnetworks = merge(
    { (var.region) = try(google_compute_subnetwork.relay_gce[0].id, null) },
    { for region, subnet in google_compute_subnetwork.relay_gce_additional : region => subnet.id }
  )
  relay_gce_topology = {
    max_surge                  = 0
    max_unavailable            = 1
    backend_group_count        = 1
    public_access_config_count = 0
    backend_timeout_seconds    = 86400
    connection_drain_seconds   = 300
  }
  relay_gce_cell_urls = {
    for cell_id, cell in var.relay_gce_cells :
    cell_id => "https://${cell.hostname}.${var.relay_gce_domain}"
  }
  relay_gce_cell_target_sizes = {
    for cell_id in keys(var.relay_gce_cells) :
    cell_id => contains(var.relay_gce_fenced_cells, cell_id) ? 0 : 1
  }
  relay_director_cells = local.relay_gce_cells_enabled ? {
    for cell_id, cell in var.relay_gce_cells : cell_id => {
      url                         = local.relay_gce_cell_urls[cell_id]
      region                      = cell.region
      capacity_requests           = cell.capacity_requests
      initially_enabled           = cell.initially_enabled
      connection_hard_cap         = cell.connection_hard_cap
      connection_unobserved_bound = cell.connection_unobserved_bound
    }
    } : {
    for cell_id, cell in var.relay_cells : cell_id => {
      url                         = cell.url
      region                      = "us-central1"
      capacity_requests           = cell.capacity_requests
      initially_enabled           = true
      connection_hard_cap         = null
      connection_unobserved_bound = null
    }
  }
  relay_director_cells_json = jsonencode([
    for cell_id, cell in local.relay_director_cells : merge(
      {
        id               = cell_id
        url              = cell.url
        region           = cell.region
        capacityRequests = cell.capacity_requests
        initiallyEnabled = cell.initially_enabled
      },
      try(cell.connection_hard_cap, null) == null ? {} : {
        connectionHardCap         = cell.connection_hard_cap
        connectionUnobservedBound = cell.connection_unobserved_bound
      }
    )
  ])
}

check "relay_gce_fixed_one_topology" {
  assert {
    condition = alltrue([
      for region in keys(var.relay_gce_additional_region_subnetwork_cidrs) : region != var.region
      ]) && alltrue([
      for cell in values(var.relay_gce_cells) :
      cell.region == var.region || contains(keys(var.relay_gce_additional_region_subnetwork_cidrs), cell.region)
    ])
    error_message = "Additional Relay regions must differ from the primary region, and every cell region needs a configured subnetwork."
  }

  assert {
    condition = alltrue([
      for cell_id in var.relay_gce_fenced_cells : contains(keys(var.relay_gce_cells), cell_id)
    ])
    error_message = "relay_gce_fenced_cells may contain only configured relay_gce_cells keys."
  }

  assert {
    condition = alltrue([
      for cell_id in var.relay_region_rehome_source_cell_ids : try(
        var.relay_gce_cells[cell_id].region == var.region &&
        var.relay_gce_cells[cell_id].connection_hard_cap != null &&
        !contains(var.relay_gce_fenced_cells, cell_id),
        false
      )
    ])
    error_message = "Regional rehome sources must be configured, unfenced primary-region GCE cells with explicit connection limits."
  }

  assert {
    condition     = length(var.relay_gce_cells) == 0 || var.relay_gce_domain != ""
    error_message = "relay_gce_domain is required when GCE cells are configured."
  }

  assert {
    condition = (
      alltrue([
        for cell_id, target_size in local.relay_gce_cell_target_sizes :
        contains(var.relay_gce_fenced_cells, cell_id) ? target_size == 0 : target_size == 1
      ]) &&
      local.relay_gce_topology.max_surge == 0 &&
      local.relay_gce_topology.max_unavailable == 1 &&
      local.relay_gce_topology.backend_group_count == 1 &&
      local.relay_gce_topology.public_access_config_count == 0 &&
      local.relay_gce_topology.backend_timeout_seconds == 86400
    )
    error_message = "Relay cells require fixed-one RECREATE MIGs, one non-public backend, and the 86,400-second WebSocket timeout."
  }
}

resource "google_compute_health_check" "relay_gce_liveness" {
  count = local.relay_gce_cells_enabled ? 1 : 0

  project             = var.project_id
  name                = "${local.relay_gce_name}-health"
  check_interval_sec  = 10
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3

  http_health_check {
    port         = 8080
    request_path = "/health"
  }

  log_config {
    enable = true
  }

  # A project's first Compute API enablement can return before health-check
  # creation is accepted, so keep this independent root behind the service.
}

resource "google_compute_health_check" "relay_gce_readiness" {
  count = local.relay_gce_cells_enabled ? 1 : 0

  project             = var.project_id
  name                = "${local.relay_gce_name}-ready"
  check_interval_sec  = 10
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 2

  http_health_check {
    port         = 8080
    request_path = "/ready"
  }

  log_config {
    enable = true
  }

  # This check has no other Compute dependency to serialize initial API use.
}

resource "google_compute_instance_template" "relay_gce_cell" {
  for_each = var.relay_gce_cells

  project        = var.project_id
  name_prefix    = "${substr("${local.relay_gce_name}-${each.value.hostname}", 0, 52)}-"
  machine_type   = each.value.machine_type
  can_ip_forward = false
  tags           = ["orca-relay-cell"]
  labels = merge(
    local.relay_shared_labels,
    {
      orca-relay-role = "cell"
      orca-relay-cell = each.key
    },
    each.value.region == var.region ? {} : { orca-relay-region = each.value.region }
  )

  disk {
    auto_delete  = true
    boot         = true
    device_name  = "persistent-disk-0"
    disk_size_gb = each.value.boot_disk_gb
    disk_type    = "pd-balanced"
    source_image = each.value.boot_image
  }

  network_interface {
    subnetwork = local.relay_gce_subnetworks[each.value.region]

    # An empty dynamic block makes the no-public-IP invariant machine-checkable.
    dynamic "access_config" {
      for_each = range(local.relay_gce_topology.public_access_config_count)
      content {}
    }
  }

  service_account {
    email  = local.relay_runtime_service_account_email
    scopes = ["cloud-platform"]
  }

  scheduling {
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
    provisioning_model  = "STANDARD"
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    block-project-ssh-keys = "TRUE"
    enable-oslogin         = "TRUE"
    google-logging-enabled = "TRUE"
  }

  metadata_startup_script = templatefile("${path.module}/relay-gce-startup.sh.tftpl", {
    project_id                      = var.project_id
    database_secret                 = google_secret_manager_secret.relay_database_url.secret_id
    assignment_secret               = google_secret_manager_secret.relay_assignment_signing_key.secret_id
    cell_id                         = each.key
    cell_region                     = each.value.region
    include_cell_region             = each.value.region != var.region
    cell_url                        = local.relay_gce_cell_urls[each.key]
    capacity_requests               = each.value.capacity_requests
    database_pool_max               = each.value.database_pool_max
    include_database_pool_max       = each.value.region != var.region || each.value.database_pool_max != 10
    connection_hard_cap             = each.value.connection_hard_cap
    connection_unobserved_bound     = each.value.connection_unobserved_bound
    auth_issuer                     = var.auth_base_url
    director_url                    = var.relay_base_url
    deploy_service_account          = local.relay_github_deploy_service_account_email
    capacity_service_account        = local.relay_capacity_service_account_email
    asia_proof_service_account      = local.relay_asia_proof_service_account_email
    runtime_service_account         = local.relay_runtime_service_account_email
    rehome_source_enabled           = contains(var.relay_region_rehome_source_cell_ids, each.key)
    rehome_director_service_account = local.relay_director_runtime_service_account_email
    rehome_audience                 = "${var.relay_base_url}/v1/admin/host-drain"
    artifact_registry_host          = "${var.region}-docker.pkg.dev"
    relay_image                     = each.value.image
    cloud_sql_proxy_image           = var.relay_gce_cloud_sql_proxy_image
    # Keep cell-only plans independent from unrelated database configuration drift.
    cloud_sql_connection_name = local.relay_database_connection_name
  })

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    google_project_iam_member.relay_runtime_artifact_reader,
    google_project_iam_member.relay_runtime_cloudsql_client,
    google_project_iam_member.relay_runtime_log_writer,
    google_secret_manager_secret_iam_member.relay_assignment_signing_key_accessor,
    google_secret_manager_secret_iam_member.relay_database_url_accessor
  ]
}

resource "google_compute_instance_group_manager" "relay_gce_cell" {
  for_each = var.relay_gce_cells

  project            = var.project_id
  name               = "${local.relay_gce_name}-${each.value.hostname}"
  zone               = each.value.zone
  base_instance_name = "relay-${each.value.hostname}"
  target_size        = local.relay_gce_cell_target_sizes[each.key]

  version {
    name              = "primary"
    instance_template = google_compute_instance_template.relay_gce_cell[each.key].self_link
  }

  named_port {
    name = "relay"
    port = 8080
  }

  auto_healing_policies {
    health_check      = google_compute_health_check.relay_gce_liveness[0].id
    initial_delay_sec = 180
  }

  update_policy {
    type                           = "PROACTIVE"
    minimal_action                 = "REPLACE"
    most_disruptive_allowed_action = "REPLACE"
    replacement_method             = "RECREATE"
    max_surge_fixed                = local.relay_gce_topology.max_surge
    max_unavailable_fixed          = local.relay_gce_topology.max_unavailable
  }

  lifecycle {
    precondition {
      condition     = contains([0, 1], local.relay_gce_cell_target_sizes[each.key])
      error_message = "A relay cell MIG must be fenced at zero or active at exactly one."
    }
  }
}

resource "google_compute_backend_service" "relay_gce_cell" {
  for_each = var.relay_gce_cells

  project                         = var.project_id
  name                            = "${local.relay_gce_name}-${each.value.hostname}"
  protocol                        = "HTTP"
  port_name                       = "relay"
  load_balancing_scheme           = "EXTERNAL_MANAGED"
  timeout_sec                     = local.relay_gce_topology.backend_timeout_seconds
  connection_draining_timeout_sec = local.relay_gce_topology.connection_drain_seconds
  health_checks                   = [google_compute_health_check.relay_gce_readiness[0].id]
  session_affinity                = "NONE"

  backend {
    group           = google_compute_instance_group_manager.relay_gce_cell[each.key].instance_group
    balancing_mode  = "UTILIZATION"
    max_utilization = 0.8
    capacity_scaler = 1
  }

  # Per-connection client IP/status/latency for the data plane; a WebSocket logs once, at close.
  log_config {
    enable      = true
    sample_rate = var.relay_gce_cell_log_sample_rate
  }

  lifecycle {
    precondition {
      condition     = local.relay_gce_topology.backend_group_count == 1
      error_message = "Each exact relay host must route to one non-overlapping fixed-one MIG."
    }
  }
}

resource "google_compute_url_map" "relay_gce" {
  count = local.relay_gce_cells_enabled ? 1 : 0

  project         = var.project_id
  name            = local.relay_gce_name
  default_service = google_compute_backend_service.relay_gce_cell[sort(keys(var.relay_gce_cells))[0]].id

  # Unknown wildcard hosts fail at the LB and can never fall through to a cell.
  default_route_action {
    fault_injection_policy {
      abort {
        http_status = 404
        percentage  = 100
      }
    }
  }

  dynamic "host_rule" {
    for_each = var.relay_gce_cells
    iterator = cell
    content {
      hosts        = ["${cell.value.hostname}.${var.relay_gce_domain}"]
      path_matcher = "cell-${cell.value.hostname}"
    }
  }

  dynamic "path_matcher" {
    for_each = var.relay_gce_cells
    iterator = cell
    content {
      name            = "cell-${cell.value.hostname}"
      default_service = google_compute_backend_service.relay_gce_cell[cell.key].id
    }
  }
}

resource "google_compute_target_https_proxy" "relay_gce" {
  count = local.relay_gce_cells_enabled ? 1 : 0

  project         = var.project_id
  name            = local.relay_gce_name
  url_map         = google_compute_url_map.relay_gce[0].id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.relay_gce[0].id}"
  quic_override   = "NONE"
}

resource "google_compute_global_forwarding_rule" "relay_gce" {
  count = local.relay_gce_cells_enabled ? 1 : 0

  project               = var.project_id
  name                  = local.relay_gce_name
  ip_address            = google_compute_global_address.relay_gce[0].id
  port_range            = "443"
  target                = google_compute_target_https_proxy.relay_gce[0].id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  network_tier          = "PREMIUM"
}
