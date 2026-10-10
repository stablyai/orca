# Relay custom domains. The Cloud Run domain mapping is the whole story here: Google issues and
# renews the certificate, and the DNS records that point at ghs.googlehosted.com are managed
# outside this root (the auth and artifact records moved to the apps root with their services).

locals {
  relay_fqdn = replace(replace(var.relay_base_url, "https://", ""), "http://", "")
  relay_cell_fqdns = {
    for cell_id, cell in var.relay_cells :
    cell_id => replace(replace(cell.url, "https://", ""), "http://", "")
  }
}

resource "google_cloud_run_domain_mapping" "relay" {
  count    = var.manage_relay_domain_mapping ? 1 : 0
  location = var.region
  name     = local.relay_fqdn

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.relay.name
  }

  # gcloud-created mappings report an empty legacy certificate_mode even
  # though Google provisions the same automatic certificate; replacing it
  # would reset issuance for no behavioral change.
  lifecycle {
    ignore_changes = [spec[0].certificate_mode]
  }
}

resource "google_cloud_run_domain_mapping" "relay_cell" {
  for_each = var.manage_relay_domain_mapping ? var.relay_cells : {}

  location = var.region
  name     = local.relay_cell_fqdns[each.key]

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.relay_cell[each.key].name
  }
}
