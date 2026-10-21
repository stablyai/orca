# Orca-run TLS edges: a cell's own hostname answered by Envoy on a VM with a static IP, so no
# Google proxy sits between a desktop and the cell. The cell is untouched and stays behind the
# shared load balancer; an edge carries traffic only once Cloudflare points the cell's exact
# hostname at the edge address, and deleting that record is the rollback.

locals {
  relay_gce_edges_enabled = local.relay_gce_cells_enabled && length(var.relay_gce_passthrough_edge_cells) > 0
  relay_gce_edges = local.relay_gce_edges_enabled ? {
    for cell_id in var.relay_gce_passthrough_edge_cells : cell_id => {
      hostname   = var.relay_gce_cells[cell_id].hostname
      fqdn       = "${var.relay_gce_cells[cell_id].hostname}.${var.relay_gce_domain}"
      region     = var.relay_gce_cells[cell_id].region
      zone       = var.relay_gce_cells[cell_id].zone
      boot_image = var.relay_gce_cells[cell_id].boot_image
    }
  } : {}
}

resource "google_service_account" "relay_edge" {
  count = local.relay_gce_edges_enabled ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-relay-edge"
  display_name = "Orca Relay TLS edges"
  description  = "Runtime identity for Orca Relay passthrough edges: writes logs and its own ACME answers."
}

resource "google_project_iam_member" "relay_edge_log_writer" {
  count = local.relay_gce_edges_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = google_service_account.relay_edge[0].member
}

resource "google_project_service" "relay_edge_dns" {
  count = local.relay_gce_edges_enabled ? 1 : 0

  project            = var.project_id
  service            = "dns.googleapis.com"
  disable_on_destroy = false
}

resource "google_dns_managed_zone" "relay_edge_acme" {
  count = local.relay_gce_edges_enabled ? 1 : 0

  project     = var.project_id
  name        = "${local.relay_gce_name}-acme"
  dns_name    = "${var.relay_gce_edge_acme_domain}."
  description = "ACME DNS-01 answers for Orca Relay passthrough edges, delegated from Cloudflare."
  labels      = local.relay_shared_labels

  depends_on = [google_project_service.relay_edge_dns]
}

# Zone-scoped, so a compromised edge can rewrite only ACME answers, never a relay hostname.
resource "google_dns_managed_zone_iam_member" "relay_edge_acme_admin" {
  count = local.relay_gce_edges_enabled ? 1 : 0

  project      = var.project_id
  managed_zone = google_dns_managed_zone.relay_edge_acme[0].name
  role         = "roles/dns.admin"
  member       = google_service_account.relay_edge[0].member
}

resource "google_compute_address" "relay_edge" {
  for_each = local.relay_gce_edges

  project      = var.project_id
  name         = "${local.relay_gce_name}-edge-${each.value.hostname}"
  region       = each.value.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"
  labels       = local.relay_shared_labels
}

# The edge finds its cell's VM by label each few seconds rather than through an internal LB: a
# passthrough ILB needs CONNECTION balancing, which GCE refuses on an instance group the shared
# LB already balances by UTILIZATION. Read-only, so a compromised edge learns topology only.
resource "google_project_iam_member" "relay_edge_compute_viewer" {
  count = local.relay_gce_edges_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/compute.viewer"
  member  = google_service_account.relay_edge[0].member
}

resource "google_compute_instance" "relay_edge" {
  for_each = local.relay_gce_edges

  project        = var.project_id
  name           = "${local.relay_gce_name}-edge-${each.value.hostname}"
  zone           = each.value.zone
  machine_type   = var.relay_gce_edge_machine_type
  can_ip_forward = false
  tags           = ["orca-relay-edge"]
  labels = merge(local.relay_shared_labels, {
    orca-relay-role = "edge"
    orca-relay-cell = each.key
  })

  boot_disk {
    auto_delete = true
    initialize_params {
      image = each.value.boot_image
      size  = 20
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = local.relay_gce_subnetworks[each.value.region]
    access_config {
      nat_ip       = google_compute_address.relay_edge[each.key].address
      network_tier = "PREMIUM"
    }
  }

  service_account {
    email  = google_service_account.relay_edge[0].email
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

  # The certificate lives on this boot disk. `startup-script` (not metadata_startup_script) so a
  # config edit updates in place and the next boot re-renders it, instead of recreating the VM and
  # reissuing a certificate against the CA's duplicate-certificate limit.
  metadata = {
    block-project-ssh-keys = "TRUE"
    enable-oslogin         = "TRUE"
    google-logging-enabled = "TRUE"
    startup-script = templatefile("${path.module}/relay-gce-edge-startup.sh.tftpl", {
      fqdn        = each.value.fqdn
      project_id  = var.project_id
      acme_zone   = google_dns_managed_zone.relay_edge_acme[0].name
      acme_server = var.relay_gce_edge_acme_server
      envoy_image = var.relay_gce_edge_envoy_image
      lego_image  = var.relay_gce_edge_lego_image
      cell_list_url = join("", [
        "https://compute.googleapis.com/compute/v1/projects/${var.project_id}/zones/${each.value.zone}/instances",
        "?filter=${urlencode("(labels.orca-relay-cell = \"${each.key}\") (labels.orca-relay-role = \"cell\") (status = \"RUNNING\")")}",
        "&fields=${urlencode("items(networkInterfaces(networkIP))")}"
      ])
      envoy_config = templatefile("${path.module}/relay-gce-edge-envoy.yaml.tftpl", {
        fqdn    = each.value.fqdn
        edge_ip = google_compute_address.relay_edge[each.key].address
      })
    })
  }

  depends_on = [
    google_project_iam_member.relay_edge_log_writer,
    google_project_iam_member.relay_edge_compute_viewer,
    google_dns_managed_zone_iam_member.relay_edge_acme_admin
  ]
}

resource "google_compute_firewall" "relay_edge_public" {
  count = local.relay_gce_edges_enabled ? 1 : 0

  project       = var.project_id
  name          = "${local.relay_gce_name}-edge-https"
  network       = google_compute_network.relay_gce[0].name
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["orca-relay-edge"]

  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
}

resource "google_compute_firewall" "relay_edge_iap_ssh" {
  count = local.relay_gce_edges_enabled ? 1 : 0

  project       = var.project_id
  name          = "${local.relay_gce_name}-edge-iap-ssh"
  network       = google_compute_network.relay_gce[0].name
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["orca-relay-edge"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# Cells admit their edge by tag alongside the shared load balancer's ranges.
resource "google_compute_firewall" "relay_edge_to_cell" {
  count = local.relay_gce_edges_enabled ? 1 : 0

  project     = var.project_id
  name        = "${local.relay_gce_name}-edge-to-cell"
  network     = google_compute_network.relay_gce[0].name
  direction   = "INGRESS"
  source_tags = ["orca-relay-edge"]
  target_tags = ["orca-relay-cell"]

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }
}

# Both edge-certificate alerts notify without paging: the CA allows 30 days of retries before a
# certificate expires, and the rollback (delete the cell's DNS record) needs no edge at all.
resource "google_logging_metric" "relay_edge_certificate_check_failures" {
  count = local.relay_gce_edges_enabled ? 1 : 0

  project     = var.project_id
  name        = "orca_relay_edge_certificate_check_failures"
  description = "Edge certificate issue/renew attempts that failed. The edge keeps serving its current certificate."
  filter      = "resource.type=\"gce_instance\" AND logName=\"projects/${var.project_id}/logs/cos_containers\" AND jsonPayload.message:\"[orca-relay-edge] certificate check failed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "relay_edge_certificate_check_failures" {
  count = local.relay_gce_edges_enabled ? 1 : 0

  project               = var.project_id
  display_name          = "Orca Relay: edge certificate renewal failed"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "An edge certificate issue or renewal attempt failed"

    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.relay_edge_certificate_check_failures[0].name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.\"instance_id\""]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "An Orca Relay TLS edge could not issue or renew its certificate. It keeps serving the current one, which renews from 30 days before expiry, so this is days of warning, not an outage. Read the edge's `orca-relay-edge-acme` container log (the line before `certificate check failed`). Usual causes: the Cloudflare delegation of the ACME zone or the cell's `_acme-challenge` CNAME was removed, or the CA is down. If the certificate will expire before the fix, delete the cell's Cloudflare A record so its hostname falls back to the shared load balancer."
    mime_type = "text/markdown"
  }
}

# Reads whatever certificate the hostname serves: the load balancer's before cutover, the edge's
# after, so it never needs flipping.
resource "google_monitoring_uptime_check_config" "relay_edge_cell" {
  for_each = local.relay_gce_edges

  project      = var.project_id
  display_name = "Orca Relay edge ${each.value.fqdn}"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path           = "/health"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = each.value.fqdn
    }
  }
}

resource "google_monitoring_alert_policy" "relay_edge_certificate_expiry" {
  count = local.relay_gce_edges_enabled ? 1 : 0

  project               = var.project_id
  display_name          = "Orca Relay: edge cell certificate expires within 21 days"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "Certificate served for an edge cell hostname expires within 21 days"

    condition_threshold {
      # Scoped to these checks: the project's other uptime checks are not edge certificates.
      filter = join(" AND ", [
        "resource.type=\"uptime_url\"",
        "metric.type=\"monitoring.googleapis.com/uptime_check/time_until_ssl_cert_expires\"",
        "metric.label.\"check_id\"=one_of(${join(",", [for check in google_monitoring_uptime_check_config.relay_edge_cell : "\"${check.uptime_check_id}\""])})"
      ])
      comparison      = "COMPARISON_LT"
      threshold_value = 21
      duration        = "600s"

      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_MIN"
        group_by_fields      = ["resource.label.\"host\""]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "A relay cell hostname served through an Orca TLS edge has a certificate within 21 days of expiry, so renewal has failed for about nine days. See `Orca Relay: edge certificate renewal failed`. To stop depending on the edge, delete the cell's Cloudflare A record; the hostname falls back to the shared load balancer's Google-managed certificate within the record's 60-second TTL."
    mime_type = "text/markdown"
  }
}
