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
    image             = "us-central1-docker.pkg.dev/onorca-cloud-staging/orca-cloud/relay@sha256:2d0f6e6db2b0eb9d6aba188698de8330f8c30b4e76badfcf0fac3f3eb9508a87"
  }
  "staging-gce-c2" = {
    hostname                    = "c2"
    zone                        = "us-central1-c"
    machine_type                = "e2-standard-2"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-7"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud-staging/orca-cloud/relay@sha256:1239830d0946dc92ded3c9edde1c0b827f584a7a2be5c177beed900056d76f69"
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
    image                       = "us-central1-docker.pkg.dev/onorca-cloud-staging/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 3000
    connection_unobserved_bound = 60
  }
}

relay_region_rehome_source_cell_ids = ["staging-gce-c2", "staging-gce-c3"]
