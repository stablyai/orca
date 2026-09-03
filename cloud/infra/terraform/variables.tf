variable "artifact_repository_id" {
  type        = string
  description = "Artifact Registry Docker repository ID."
}

variable "environment" {
  type        = string
  description = "Deployment environment."

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "github_owner" {
  type        = string
  description = "GitHub owner allowed to deploy through Workload Identity Federation."
  default     = "stablyai"
}

variable "github_repo" {
  type        = string
  description = "GitHub repo allowed to deploy through Workload Identity Federation."
  default     = "orca-cloud"
}

# Numeric IDs survive a rename or transfer of the repository; every provider pins them next to the name.
variable "github_repo_id" {
  type        = string
  description = "Numeric GitHub repository ID of github_owner/github_repo."
  default     = "1273841466"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repo_id))
    error_message = "github_repo_id must be the numeric repository ID."
  }
}

variable "github_owner_id" {
  type        = string
  description = "Numeric GitHub owner ID of github_owner."
  default     = "127256420"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "github_owner_id must be the numeric owner ID."
  }
}

# Additional repositories whose identical workflows the same identities must accept while the
# public extraction runs. Each entry renders its own OR arm in every provider condition, so the
# private repo keeps working while the public one takes over. `workflow_file_prefix` is the rename
# the importing repository applies to the workflow files it copies. Empty is the steady state:
# the final step of the cutover is to empty this list again and point github_owner/github_repo,
# github_repo_id, and github_owner_id at the surviving repository.
variable "github_accepted_repositories" {
  type = list(object({
    owner                = string
    repo                 = string
    repo_id              = string
    owner_id             = string
    workflow_file_prefix = string
  }))
  description = "Extra repositories accepted alongside github_owner/github_repo during the public extraction."
  default     = []

  validation {
    condition = alltrue([
      for repository in var.github_accepted_repositories :
      can(regex("^[0-9]+$", repository.repo_id)) && can(regex("^[0-9]+$", repository.owner_id))
    ])
    error_message = "github_accepted_repositories entries must carry numeric repo_id and owner_id values."
  }

  validation {
    condition = alltrue([
      for repository in var.github_accepted_repositories :
      can(regex("^[a-z0-9-]*$", repository.workflow_file_prefix))
    ])
    error_message = "github_accepted_repositories workflow_file_prefix must be lowercase letters, digits, or hyphens."
  }
}

variable "name_prefix" {
  type        = string
  description = "Prefix used for named resources."
}

variable "project_id" {
  type        = string
  description = "GCP project ID."
}

variable "region" {
  type        = string
  description = "GCP region for regional resources."
  default     = "us-central1"
}

variable "auth_base_url" {
  type        = string
  description = "Public base URL of the auth service; OAuth callbacks and JWT issuer derive from it."
}

variable "manage_relay_domain_mapping" {
  type        = bool
  description = "Manage the Google Cloud Run mapping independently of the Cloudflare record."
  default     = false
}

variable "relay_base_url" {
  type        = string
  description = "Public TLS origin of the stable relay director."
}

variable "relay_cloud_run_service_name" {
  type        = string
  description = "Cloud Run service name for Orca Relay."
}

variable "relay_staging_power_auth_service_name" {
  type        = string
  description = "Shared staging auth Cloud Run service that Power Relay Staging scales to zero; empty outside staging."
  default     = ""
}

variable "relay_cloud_run_image" {
  type        = string
  description = "Initial image for the Terraform-created relay Cloud Run service."
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "relay_cloud_run_cpu" {
  type        = string
  description = "CPU limit for the relay container."
  default     = "1"
}

variable "relay_cloud_run_memory" {
  type        = string
  description = "Memory limit for the relay container."
  default     = "512Mi"
}

variable "relay_fence_broker_service_name" {
  type        = string
  description = "Private Cloud Run service that owns reviewed Relay Terraform fences."
  default     = "orca-cloud-relay-fence"
}

variable "relay_fence_broker_image" {
  type        = string
  description = "Immutable image for the private Relay fence broker."
  default     = "us-docker.pkg.dev/cloudrun/container/hello"

  validation {
    condition = (
      var.relay_fence_broker_image == "us-docker.pkg.dev/cloudrun/container/hello" ||
      can(regex("^[a-z0-9.-]+/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.relay_fence_broker_image))
    )
    error_message = "relay_fence_broker_image must be the bootstrap image or an immutable digest."
  }
}

variable "relay_fence_source_cell_id" {
  type        = string
  description = "Exact incident source cell accepted by the private fence broker."
  default     = "production-gce-c3"
}

variable "relay_fence_failed_target_cell_id" {
  type        = string
  description = "Exact failed registered target accepted by the private fence broker."
  default     = "production-gce-c12"
}

variable "relay_fence_replacement_target_cell_id" {
  type        = string
  description = "Exact replacement target accepted by the private fence broker."
  default     = "production-gce-c13"
}

variable "relay_fence_unobserved_connection_bound" {
  type        = number
  description = "Reviewed unobserved connection bound enforced during supersession."
  default     = 60

  validation {
    condition = (
      var.relay_fence_unobserved_connection_bound >= 0 &&
      var.relay_fence_unobserved_connection_bound < 500
    )
    error_message = "relay_fence_unobserved_connection_bound must be between zero and 499."
  }
}

variable "relay_director_concurrency" {
  type        = number
  description = "Cloud Run concurrency for short-lived director HTTP requests."
  default     = 80
}

variable "relay_director_request_timeout_seconds" {
  type        = number
  description = "Cloud Run timeout for short-lived director HTTP requests."
  default     = 30
}

variable "relay_concurrency" {
  type        = number
  description = "Cloud Run cell concurrency; every WebSocket leg counts."
  default     = 1000
}

variable "relay_request_timeout_seconds" {
  type        = number
  description = "Cloud Run cell request timeout for standing WebSocket legs."
  default     = 3600
}

variable "relay_public_assignments_enabled" {
  type        = bool
  description = "Emergency switch for public assignment and resolve requests."
  default     = true
}

variable "relay_regional_placement_enabled" {
  type        = bool
  description = "Initial preferred-region placement state; audited director deploys own later changes."
  default     = true
}

variable "relay_region_rehome_source_cell_ids" {
  type        = set(string)
  description = "Reviewed US Relay cells allowed to advertise and accept the regional rehome source protocol."
  default     = []
}

variable "relay_public_assignment_concurrency" {
  type        = number
  description = "Per-director public assignment operations allowed to reach shared state."
  default     = 2
}

variable "relay_public_assignment_retry_after_seconds" {
  type        = number
  description = "Minimum retry interval enforced per relay host during assignment recovery."
  default     = 5
}

# Why: these three match the application defaults today. Pinning them keeps a code-side
# default change from silently re-tuning production on the next unrelated apply.
variable "relay_public_assignment_queue_max" {
  type        = number
  description = "Queued public assignment operations allowed per director instance."
  default     = 128
}

variable "relay_public_assignment_wait_ms" {
  type        = number
  description = "Milliseconds a public assignment waits for an admission slot before 503."
  default     = 4000
}

# Why: the sticky (reconnect) lane shared the assignment pool but lived only as a code
# default, so Terraform could not see it. Raising placement concurrency alone then pushed
# placement + sticky past the pool and the director refused to boot.
variable "relay_public_sticky_concurrency" {
  type        = number
  description = "Per-director reconnect-lane operations allowed to reach shared state."
  default     = 1
}

variable "relay_public_sticky_queue_max" {
  type        = number
  description = "Queued reconnect-lane operations allowed per director instance."
  default     = 64
}

variable "relay_public_sticky_wait_ms" {
  type        = number
  description = "Milliseconds a reconnect waits for an admission slot before 503."
  default     = 2000
}

variable "relay_public_sticky_retry_after_seconds" {
  type        = number
  description = "Minimum retry interval enforced per relay host during reconnect recovery."
  default     = 2
}

variable "relay_director_database_pool_max" {
  type        = number
  description = "Director database pool size; must fit placement plus sticky admission slots."
  default     = 3

  validation {
    condition     = var.relay_director_database_pool_max >= 3
    error_message = "The director pool must fit both placement and sticky admission slots."
  }
}

variable "relay_min_instances" {
  type        = number
  description = "Minimum instances for the stable relay director."
  default     = 1
}

variable "relay_max_instances" {
  type        = number
  description = "Maximum instances for the stateless stable relay director."
  default     = 2

  validation {
    condition     = var.relay_max_instances >= 1
    error_message = "The relay director needs at least one instance."
  }
}

variable "relay_cells" {
  type = map(object({
    service_name        = string
    url                 = string
    capacity_requests   = number
    min_instances       = number
    max_instances       = number
    deletion_protection = optional(bool, true)
  }))
  description = "Explicit stamped max-one relay cells keyed by durable cell ID."
  default     = {}

  validation {
    condition = alltrue([
      for cell in values(var.relay_cells) :
      cell.max_instances == 1 &&
      cell.min_instances >= 0 &&
      cell.min_instances <= cell.max_instances &&
      cell.capacity_requests >= 1 &&
      cell.capacity_requests <= 1000 &&
      can(regex("^https://[^/]+$", cell.url))
    ])
    error_message = "Relay cells must use HTTPS origins, capacity 1..1000, and max exactly one."
  }
}

variable "relay_alert_notification_channels" {
  type        = list(string)
  description = "Cloud Monitoring notification-channel resource names for Orca Relay alerts. Empty keeps policies visible without paging."
  default     = []
}

variable "relay_gce_domain" {
  type        = string
  description = "Parent DNS name for GCE relay cells; each cell is one exact host below it."
  default     = ""

  validation {
    condition = var.relay_gce_domain == "" || (
      can(regex("^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$", var.relay_gce_domain)) &&
      !startswith(var.relay_gce_domain, "*.")
    )
    error_message = "relay_gce_domain must be empty or a lowercase DNS name without a wildcard or scheme."
  }
}

variable "relay_gce_subnetwork_cidr" {
  type        = string
  description = "Private IPv4 range dedicated to GCE relay cells."
  default     = "10.42.0.0/24"

  validation {
    condition     = can(cidrhost(var.relay_gce_subnetwork_cidr, 1))
    error_message = "relay_gce_subnetwork_cidr must be a valid IPv4 CIDR."
  }
}

variable "relay_gce_additional_region_subnetwork_cidrs" {
  type        = map(string)
  description = "Private IPv4 ranges for additive Relay regions; the primary region keeps its legacy resources."
  default     = {}

  validation {
    condition = alltrue([
      for region, cidr in var.relay_gce_additional_region_subnetwork_cidrs :
      contains(["asia-east2"], region) &&
      can(cidrhost(cidr, 1))
    ])
    error_message = "Additional Relay regions must be allowlisted and use valid IPv4 CIDRs."
  }
}

variable "relay_gce_cells" {
  type = map(object({
    hostname                    = string
    region                      = optional(string, "us-central1")
    zone                        = string
    machine_type                = string
    boot_disk_gb                = number
    boot_image                  = string
    capacity_requests           = number
    database_pool_max           = optional(number, 10)
    image                       = string
    initially_enabled           = optional(bool, true)
    connection_hard_cap         = optional(number)
    connection_unobserved_bound = optional(number)
  }))
  description = "Private GCE relay cells keyed by durable cell ID; unfenced cells remain fixed-one."
  default     = {}

  validation {
    condition = alltrue([
      for cell_id, cell in var.relay_gce_cells :
      can(regex("^[a-z][a-z0-9-]{0,39}$", cell_id)) &&
      can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", cell.hostname)) &&
      contains(["us-central1", "asia-east2"], cell.region) &&
      startswith(cell.zone, "${cell.region}-") &&
      can(regex("^[a-z0-9-]+$", cell.machine_type)) &&
      can(regex("^https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-[a-z0-9-]+$", cell.boot_image)) &&
      cell.boot_disk_gb >= 20 &&
      cell.boot_disk_gb <= 100 &&
      cell.capacity_requests >= 1 &&
      cell.capacity_requests <= 100000 &&
      cell.database_pool_max >= 1 &&
      cell.database_pool_max <= 100 &&
      (
        (cell.connection_hard_cap == null &&
        cell.connection_unobserved_bound == null) ||
        try(
          contains([600, 1000, 3000], cell.connection_hard_cap) &&
          cell.connection_unobserved_bound >= 0 &&
          cell.connection_unobserved_bound < cell.connection_hard_cap - 100,
          false
        )
      ) &&
      can(regex("^[a-z0-9.-]+/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", cell.image))
    ]) && length(distinct([for cell in values(var.relay_gce_cells) : cell.hostname])) == length(var.relay_gce_cells)
    error_message = "GCE cells need an allowlisted region and matching zone, unique DNS labels, a pinned COS boot image, bounded machine/disk/capacity/pool values, paired supported connection limits with rebind headroom, and digest-pinned relay images."
  }
}

variable "relay_gce_cell_log_sample_rate" {
  type        = number
  description = "Fraction of relay cell load-balancer requests written to Cloud Logging; 1 keeps assign-to-connection joins exact."
  default     = 1

  validation {
    condition     = var.relay_gce_cell_log_sample_rate >= 0 && var.relay_gce_cell_log_sample_rate <= 1
    error_message = "relay_gce_cell_log_sample_rate must be between 0 and 1."
  }
}

variable "relay_gce_fenced_cells" {
  type        = set(string)
  description = "Reviewed relay GCE cell IDs whose Terraform-owned MIG target size is zero."
  default     = []
}

variable "relay_gce_cloud_sql_proxy_image" {
  type        = string
  description = "Digest-pinned Cloud SQL Auth Proxy image used by private relay workers."
  default     = "gcr.io/cloud-sql-connectors/cloud-sql-proxy@sha256:fc224915ef435afeb5b2a9421260a0d31986d5c8b7c7f5783c7f5d5885700cd2"

  validation {
    condition     = can(regex("^[a-z0-9.-]+/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.relay_gce_cloud_sql_proxy_image))
    error_message = "relay_gce_cloud_sql_proxy_image must be pinned by sha256 digest."
  }
}
