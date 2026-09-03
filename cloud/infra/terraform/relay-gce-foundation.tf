locals {
  relay_gce_configured = var.relay_gce_domain != ""
  relay_gce_name       = "${var.name_prefix}-relay-gce"
}

resource "google_compute_network" "relay_gce" {
  count = local.relay_gce_configured ? 1 : 0

  project                 = var.project_id
  name                    = local.relay_gce_name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "relay_gce" {
  count = local.relay_gce_configured ? 1 : 0

  project                  = var.project_id
  name                     = local.relay_gce_name
  region                   = var.region
  network                  = google_compute_network.relay_gce[0].id
  ip_cidr_range            = var.relay_gce_subnetwork_cidr
  private_ip_google_access = true
  stack_type               = "IPV4_ONLY"
}

resource "google_compute_router" "relay_gce" {
  count = local.relay_gce_configured ? 1 : 0

  project = var.project_id
  name    = local.relay_gce_name
  region  = var.region
  network = google_compute_network.relay_gce[0].id
}

resource "google_compute_router_nat" "relay_gce" {
  count = local.relay_gce_configured ? 1 : 0

  project                            = var.project_id
  name                               = local.relay_gce_name
  region                             = var.region
  router                             = google_compute_router.relay_gce[0].name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.relay_gce[0].id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# The primary US resources above retain their production addresses. New regions are additive.
resource "google_compute_subnetwork" "relay_gce_additional" {
  for_each = local.relay_gce_configured ? var.relay_gce_additional_region_subnetwork_cidrs : {}

  project                  = var.project_id
  name                     = "${local.relay_gce_name}-${each.key}"
  region                   = each.key
  network                  = google_compute_network.relay_gce[0].id
  ip_cidr_range            = each.value
  private_ip_google_access = true
  stack_type               = "IPV4_ONLY"
}

resource "google_compute_router" "relay_gce_additional" {
  for_each = local.relay_gce_configured ? var.relay_gce_additional_region_subnetwork_cidrs : {}

  project = var.project_id
  name    = "${local.relay_gce_name}-${each.key}"
  region  = each.key
  network = google_compute_network.relay_gce[0].id
}

resource "google_compute_router_nat" "relay_gce_additional" {
  for_each = local.relay_gce_configured ? var.relay_gce_additional_region_subnetwork_cidrs : {}

  project                            = var.project_id
  name                               = "${local.relay_gce_name}-${each.key}"
  region                             = each.key
  router                             = google_compute_router.relay_gce_additional[each.key].name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.relay_gce_additional[each.key].id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

resource "google_compute_firewall" "relay_gce_load_balancer" {
  count = local.relay_gce_configured ? 1 : 0

  project       = var.project_id
  name          = "${local.relay_gce_name}-lb"
  network       = google_compute_network.relay_gce[0].name
  direction     = "INGRESS"
  source_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
  target_tags   = ["orca-relay-cell"]

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }
}

resource "google_compute_firewall" "relay_gce_iap_ssh" {
  count = local.relay_gce_configured ? 1 : 0

  project       = var.project_id
  name          = "${local.relay_gce_name}-iap-ssh"
  network       = google_compute_network.relay_gce[0].name
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["orca-relay-cell"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_project_iam_member" "relay_runtime_artifact_reader" {
  count = local.relay_gce_configured ? 1 : 0

  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = google_service_account.relay_runtime.member
}

resource "google_project_iam_member" "relay_runtime_log_writer" {
  count = local.relay_gce_configured ? 1 : 0

  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = google_service_account.relay_runtime.member
}

resource "google_compute_global_address" "relay_gce" {
  count = local.relay_gce_configured ? 1 : 0

  project      = var.project_id
  name         = local.relay_gce_name
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
}

resource "google_certificate_manager_dns_authorization" "relay_gce" {
  count = local.relay_gce_configured ? 1 : 0

  project     = var.project_id
  name        = local.relay_gce_name
  domain      = var.relay_gce_domain
  location    = "global"
  type        = "PER_PROJECT_RECORD"
  description = "DNS authorization for Orca Relay wildcard cell certificates."
  labels      = local.relay_shared_labels
}

resource "google_certificate_manager_certificate" "relay_gce" {
  count = local.relay_gce_configured ? 1 : 0

  project     = var.project_id
  name        = local.relay_gce_name
  location    = "global"
  description = "Wildcard certificate for exact-routed Orca Relay GCE cells."
  labels      = local.relay_shared_labels

  managed {
    domains            = ["*.${var.relay_gce_domain}"]
    dns_authorizations = [google_certificate_manager_dns_authorization.relay_gce[0].id]
  }
}

resource "google_certificate_manager_certificate_map" "relay_gce" {
  count = local.relay_gce_configured ? 1 : 0

  project     = var.project_id
  name        = local.relay_gce_name
  description = "Certificate map for the shared Orca Relay HTTPS load balancer."
}

resource "google_certificate_manager_certificate_map_entry" "relay_gce" {
  count = local.relay_gce_configured ? 1 : 0

  project      = var.project_id
  name         = "${local.relay_gce_name}-wildcard"
  map          = google_certificate_manager_certificate_map.relay_gce[0].name
  hostname     = "*.${var.relay_gce_domain}"
  certificates = [google_certificate_manager_certificate.relay_gce[0].id]
}
