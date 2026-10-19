project_id  = "onorca-cloud-staging"
environment = "staging"
name_prefix = "orca-cloud-staging"
region      = "us-central1"

artifact_repository_id = "orca-cloud"

# The relay source lives in the public stablyai/orca repository, where the workflows carry a
# `cloud-` file prefix. github_owner and github_owner_id keep their defaults.
github_repo                 = "orca"
github_repo_id              = "1183888342"
github_workflow_file_prefix = "cloud-"

auth_base_url = "https://auth-staging.onorca.dev"

relay_cloud_run_service_name          = "orca-cloud-relay-staging"
relay_staging_power_auth_service_name = "orca-cloud-auth-staging"
relay_base_url                        = "https://relay-staging.onorca.dev"
relay_min_instances                   = 0
relay_max_instances                   = 2

# Staging proves these before production turns them on.
relay_director_cloud_sql_proxy_sidecar = true
relay_event_loop_stall_alert           = true
relay_dead_cell_verdict_alert          = true
# What the serving staging director runs (revision 00171, 2026-10-11). Pinned so the sidecar apply,
# whose revision the next deploy adopts as its shape, does not also drop it to the 80 / 30 s defaults.
relay_director_concurrency             = 1000
relay_director_request_timeout_seconds = 3600
# Staging now exercises the production-shaped GCE data plane exclusively.
relay_cells = {}
# Keep the stable director mapping Terraform-owned while removing cell mappings.
manage_relay_domain_mapping = true

# GCE cells use exact hosts below this wildcard, for example
# c1.relay-staging.onorca.dev. Cloudflare records remain out-of-band.
relay_gce_domain          = "relay-staging.onorca.dev"
relay_gce_subnetwork_cidr = "10.42.0.0/24"
relay_gce_additional_region_subnetwork_cidrs = {
  "asia-east2" = "10.42.1.0/24"
}
relay_gce_fenced_cells = []
relay_gce_cells = {
  "staging-gce-c1" = {
    hostname          = "c1"
    zone              = "us-central1-b"
    machine_type      = "e2-standard-2"
    boot_disk_gb      = 30
    boot_image        = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-7"
    capacity_requests = 4000
    # Step-6 image J (main 30f5bef9, phonePath). Never 2d0f6e6: it cannot report capped telemetry.
    image = "us-central1-docker.pkg.dev/onorca-cloud-staging/orca-cloud/relay@sha256:21f1fead4d3b9900d3b1179fd72569dcba548dc0ee29c76c8389fec94f74a7b4"
    # Step-5 staging e2e: c1 is the second US reserve cell, so it needs a cap and rehome trust.
    connection_hard_cap         = 600
    connection_unobserved_bound = 60
  }
  "staging-gce-c2" = {
    hostname                    = "c2"
    zone                        = "us-central1-c"
    machine_type                = "e2-standard-2"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-7"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud-staging/orca-cloud/relay@sha256:41cba995b288cab70579882ebef23e74c5ee426b6f8924cea7c986aba23bcbfe"
    connection_hard_cap         = 600
    connection_unobserved_bound = 60
  }
  "staging-gce-c3" = {
    hostname                    = "c3"
    zone                        = "us-central1-a"
    machine_type                = "e2-standard-2"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-7"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud-staging/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "staging-gce-c4" = {
    hostname                    = "c4"
    region                      = "asia-east2"
    zone                        = "asia-east2-a"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 6000
    database_pool_max           = 10
    image                       = "us-central1-docker.pkg.dev/onorca-cloud-staging/orca-cloud/relay@sha256:21f1fead4d3b9900d3b1179fd72569dcba548dc0ee29c76c8389fec94f74a7b4"
    initially_enabled           = false
    connection_hard_cap         = 3000
    connection_unobserved_bound = 60
  }
  # Dead-cell guard e2e: six feed cells, five in the US, so one dead US cell is 1/6 of the fleet and
  # 1/5 of its region (cell-poll-reachability.ts). c2's shape.
  "staging-gce-c5" = {
    hostname                    = "c5"
    zone                        = "us-central1-a"
    machine_type                = "e2-standard-2"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-7"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud-staging/orca-cloud/relay@sha256:07b5bf67a7706b2a61ef5e9a6d8ce85ee37c2a08609496a94eb5254881b5b87d"
    connection_hard_cap         = 600
    connection_unobserved_bound = 60
  }
  "staging-gce-c6" = {
    hostname                    = "c6"
    zone                        = "us-central1-b"
    machine_type                = "e2-standard-2"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-7"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud-staging/orca-cloud/relay@sha256:07b5bf67a7706b2a61ef5e9a6d8ce85ee37c2a08609496a94eb5254881b5b87d"
    connection_hard_cap         = 600
    connection_unobserved_bound = 60
  }
  "staging-gce-c7" = {
    hostname                    = "c7"
    zone                        = "us-central1-f"
    machine_type                = "e2-standard-2"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-7"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud-staging/orca-cloud/relay@sha256:07b5bf67a7706b2a61ef5e9a6d8ce85ee37c2a08609496a94eb5254881b5b87d"
    connection_hard_cap         = 600
    connection_unobserved_bound = 60
  }
}

# c1, c4 and c5-c7 hold rehome trust for the step-5 staging e2e: the seat feed, reserve and demote
# routes need it.
relay_region_rehome_source_cell_ids = [
  "staging-gce-c1", "staging-gce-c2", "staging-gce-c3", "staging-gce-c4",
  "staging-gce-c5", "staging-gce-c6", "staging-gce-c7"
]

# Push is currently provisioned only in production.
push_gateway_enabled = false
