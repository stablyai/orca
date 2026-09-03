project_id  = "onorca-cloud"
environment = "production"
name_prefix = "orca-cloud"
region      = "us-central1"

artifact_repository_id = "orca-cloud"

# Dual accept while the relay source moves to the public stablyai/orca repository: the same
# workflows are trusted from both repos, and the public copies carry a `cloud-` file prefix.
# Remove this entry once the private workflows are retired and point github_owner/github_repo,
# github_repo_id, and github_owner_id at the surviving repository.
github_accepted_repositories = [
  {
    owner                = "stablyai"
    repo                 = "orca"
    repo_id              = "1183888342"
    owner_id             = "127256420"
    workflow_file_prefix = "cloud-"
  }
]

# Our first-party auth service. auth.onorca.dev is PropelAuth's prod domain, so
# our service lives at login.onorca.dev (desktop points ORCA_CLOUD_API_URL here).
auth_base_url = "https://login.onorca.dev"

relay_cloud_run_service_name = "orca-cloud-relay"
relay_base_url               = "https://relay.onorca.dev"
# Why: public admission is a per-instance semaphore, so fleet assignment capacity is
# concurrency x instances. Scaling to 2 instances took placement failures 35% -> 70%.
relay_min_instances = 5
relay_max_instances = 5
# Production cells run only on fixed-one GCE MIGs; Cloud Run remains the director.
relay_cells                 = {}
manage_relay_domain_mapping = true

# Production GCE cells use exact hosts such as c1.relay.onorca.dev.
# The wildcard only handles DNS/TLS; the load balancer rejects unknown hosts.
relay_gce_domain          = "relay.onorca.dev"
relay_gce_subnetwork_cidr = "10.42.0.0/24"
relay_gce_additional_region_subnetwork_cidrs = {
  "asia-east2" = "10.42.1.0/24"
}
relay_gce_fenced_cells = ["production-gce-c1", "production-gce-c2", "production-gce-c3", "production-gce-c6", "production-gce-c11", "production-gce-c12"]
# Initial cells stay admission-disabled until production preflight and go-live approval.
relay_gce_cells = {
  "production-gce-c1" = {
    hostname          = "c1"
    zone              = "us-central1-a"
    machine_type      = "e2-standard-4"
    boot_disk_gb      = 30
    boot_image        = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-7"
    capacity_requests = 4000
    image             = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:36a56b106c9e6d5897135c6af829085ab8fd53c85466406d9e887a7a5cfe9a02"
    initially_enabled = false
  }
  "production-gce-c2" = {
    hostname          = "c2"
    zone              = "us-central1-b"
    machine_type      = "e2-standard-4"
    boot_disk_gb      = 30
    boot_image        = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-7"
    capacity_requests = 4000
    image             = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:36a56b106c9e6d5897135c6af829085ab8fd53c85466406d9e887a7a5cfe9a02"
    initially_enabled = false
  }
  "production-gce-c3" = {
    hostname          = "c3"
    zone              = "us-central1-c"
    machine_type      = "e2-standard-4"
    boot_disk_gb      = 30
    boot_image        = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-7"
    capacity_requests = 4000
    image             = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:19ef4e6e4a043f63d78011d1c29a395a9002ec077d03ee6931f25479fe66f349"
    initially_enabled = false
  }
  # Distinct origins let each existing cell drain without an in-place image swap.
  "production-gce-c4" = {
    hostname          = "c4"
    zone              = "us-central1-b"
    machine_type      = "e2-standard-4"
    boot_disk_gb      = 30
    boot_image        = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests = 4000
    image             = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:36a56b106c9e6d5897135c6af829085ab8fd53c85466406d9e887a7a5cfe9a02"
    initially_enabled = false
  }
  "production-gce-c5" = {
    hostname          = "c5"
    zone              = "us-central1-c"
    machine_type      = "e2-standard-4"
    boot_disk_gb      = 30
    boot_image        = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests = 4000
    image             = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:0e83408b0dc08531f1e8182019dc151afc38d63ddde4ad5cc01e40247ef3681d"
    initially_enabled = false
  }
  "production-gce-c6" = {
    hostname          = "c6"
    zone              = "us-central1-a"
    machine_type      = "e2-standard-4"
    boot_disk_gb      = 30
    boot_image        = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests = 4000
    image             = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:36a56b106c9e6d5897135c6af829085ab8fd53c85466406d9e887a7a5cfe9a02"
    initially_enabled = false
  }
  "production-gce-c7" = {
    hostname                    = "c7"
    zone                        = "us-central1-a"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c8" = {
    hostname                    = "c8"
    zone                        = "us-central1-b"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c9" = {
    hostname          = "c9"
    zone              = "us-central1-c"
    machine_type      = "e2-standard-4"
    boot_disk_gb      = 30
    boot_image        = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests = 4000
    # Canary for the control-activation fence (PR #207, main b253fcd).
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c10" = {
    hostname                    = "c10"
    zone                        = "us-central1-a"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c11" = {
    hostname                    = "c11"
    zone                        = "us-central1-b"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:e592371013188b8297e395979c70a8b42c39f4bb5f90b01190f0778279cbaef5"
    initially_enabled           = false
    connection_hard_cap         = 600
    connection_unobserved_bound = 60
  }
  "production-gce-c12" = {
    hostname                    = "c12"
    zone                        = "us-central1-c"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:3d8b388dcbf190be20491ce9c14eeafa0dccd0afbb2725712f6f9d9a754838dc"
    initially_enabled           = false
    connection_hard_cap         = 600
    connection_unobserved_bound = 60
  }
  "production-gce-c13" = {
    hostname                    = "c13"
    zone                        = "us-central1-a"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c14" = {
    hostname                    = "c14"
    zone                        = "us-central1-b"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c15" = {
    hostname                    = "c15"
    zone                        = "us-central1-c"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c16" = {
    hostname                    = "c16"
    zone                        = "us-central1-a"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c17" = {
    hostname                    = "c17"
    zone                        = "us-central1-b"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:0e83408b0dc08531f1e8182019dc151afc38d63ddde4ad5cc01e40247ef3681d"
    initially_enabled           = false
    connection_hard_cap         = 600
    connection_unobserved_bound = 60
  }
  # Canary for halved control lease renewal (PR #253, main 11256b5). Chosen as the
  # smallest live cell: ~9 connections, so a replace costs 9 reconnects, not ~400.
  "production-gce-c18" = {
    hostname                    = "c18"
    zone                        = "us-central1-c"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:0e83408b0dc08531f1e8182019dc151afc38d63ddde4ad5cc01e40247ef3681d"
    initially_enabled           = false
    connection_hard_cap         = 600
    connection_unobserved_bound = 60
  }
  "production-gce-c19" = {
    hostname                    = "c19"
    zone                        = "us-central1-b"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c20" = {
    hostname                    = "c20"
    zone                        = "us-central1-b"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  # First full-size cell on the halved lease renewal, after the C18 canary measured
  # 9.15 -> 5.32 queries per connection with zero failures. C21 also carries the
  # control-close churn we still need to attribute to a client build.
  "production-gce-c21" = {
    hostname                    = "c21"
    zone                        = "us-central1-c"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c22" = {
    hostname                    = "c22"
    zone                        = "us-central1-c"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c23" = {
    hostname                    = "c23"
    zone                        = "us-central1-a"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c24" = {
    hostname                    = "c24"
    zone                        = "us-central1-b"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c25" = {
    hostname                    = "c25"
    zone                        = "us-central1-c"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c26" = {
    hostname                    = "c26"
    zone                        = "us-central1-a"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 4000
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 1000
    connection_unobserved_bound = 60
  }
  "production-gce-c27" = {
    hostname                    = "c27"
    region                      = "asia-east2"
    zone                        = "asia-east2-a"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 6000
    database_pool_max           = 10
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 3000
    connection_unobserved_bound = 60
  }
  "production-gce-c28" = {
    hostname                    = "c28"
    region                      = "asia-east2"
    zone                        = "asia-east2-b"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 6000
    database_pool_max           = 10
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 3000
    connection_unobserved_bound = 60
  }
  "production-gce-c29" = {
    hostname                    = "c29"
    region                      = "asia-east2"
    zone                        = "asia-east2-c"
    machine_type                = "e2-standard-4"
    boot_disk_gb                = 30
    boot_image                  = "https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21"
    capacity_requests           = 6000
    database_pool_max           = 10
    image                       = "us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563"
    initially_enabled           = false
    connection_hard_cap         = 3000
    connection_unobserved_bound = 60
  }
}

relay_region_rehome_source_cell_ids = [
  "production-gce-c7",
  "production-gce-c8",
  "production-gce-c9",
  "production-gce-c10",
  "production-gce-c13",
  "production-gce-c14",
  "production-gce-c15",
  "production-gce-c16",
  "production-gce-c19",
  "production-gce-c20",
  "production-gce-c21",
  "production-gce-c22",
  "production-gce-c23",
  "production-gce-c24",
  "production-gce-c25",
  "production-gce-c26"
]

# Slack #orca-relay-alerts, created out of band on 2026-08-05. Declared here because an apply
# was otherwise going to strip it from every policy, leaving the alerts firing at nobody.
relay_alert_notification_channels = ["projects/onorca-cloud/notificationChannels/4879431412695417284"]
