output "github_deploy_service_account" {
  value       = try(google_service_account.github_deploy[0].email, null)
  description = "Service account email to use in the GitHub Actions deploy workflow."
}

output "github_workload_identity_provider" {
  value       = try(google_iam_workload_identity_pool_provider.github[0].name, null)
  description = "Workload Identity provider resource name for GitHub Actions."
}

output "github_relay_monitor_workload_identity_provider" {
  value       = try(google_iam_workload_identity_pool_provider.github_monitor[0].name, null)
  description = "Exact-workflow provider for PRODUCTION_GCP_RELAY_MONITOR_WORKLOAD_IDENTITY_PROVIDER."
}

output "github_relay_monitor_service_account" {
  value       = try(google_service_account.github_monitor[0].email, null)
  description = "Read-only identity for PRODUCTION_GCP_RELAY_MONITOR_SERVICE_ACCOUNT."
}

output "github_relay_fence_workload_identity_provider" {
  value       = try(google_iam_workload_identity_pool_provider.github_fence[0].name, null)
  description = "Exact-workflow provider for PRODUCTION_GCP_RELAY_FENCE_WORKLOAD_IDENTITY_PROVIDER."
}

output "github_relay_fence_service_account" {
  value       = try(google_service_account.github_fence[0].email, null)
  description = "Narrow fencing identity for PRODUCTION_GCP_RELAY_FENCE_SERVICE_ACCOUNT."
}

output "github_staging_relay_capacity_workload_identity_provider" {
  value       = try(google_iam_workload_identity_pool_provider.github_staging_relay_capacity[0].name, null)
  description = "Exact-workflow provider for STAGING_GCP_RELAY_CAPACITY_WORKLOAD_IDENTITY_PROVIDER."
}

output "github_staging_relay_capacity_service_account" {
  value       = try(google_service_account.github_staging_relay_capacity[0].email, null)
  description = "Narrow transition identity for STAGING_GCP_RELAY_CAPACITY_SERVICE_ACCOUNT."
}

output "github_staging_relay_deploy_workload_identity_provider" {
  value       = try(google_iam_workload_identity_pool_provider.github_staging_relay_deploy[0].name, null)
  description = "Exact-workflow provider for STAGING_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER."
}

output "github_staging_relay_deploy_service_account" {
  value       = try(google_service_account.github_staging_relay_deploy[0].email, null)
  description = "Account for STAGING_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT."
}

output "github_production_relay_capacity_workload_identity_provider" {
  value       = try(google_iam_workload_identity_pool_provider.github_production_relay_capacity[0].name, null)
  description = "Exact-workflow provider for PRODUCTION_GCP_RELAY_CAPACITY_WORKLOAD_IDENTITY_PROVIDER."
}

output "github_production_relay_capacity_service_account" {
  value       = try(google_service_account.github_production_relay_capacity[0].email, null)
  description = "Narrow transition identity for PRODUCTION_GCP_RELAY_CAPACITY_SERVICE_ACCOUNT."
}

output "github_relay_asia_topology_workload_identity_provider" {
  value       = try(google_iam_workload_identity_pool_provider.github_relay_asia_topology[0].name, null)
  description = "Workflow-bound provider for validated additive Relay Asia topology plans."
}

output "github_relay_asia_topology_service_account" {
  value       = try(google_service_account.github_relay_asia_topology[0].email, null)
  description = "Dedicated identity for validated additive Relay Asia topology plans."
}

output "github_relay_asia_proof_workload_identity_provider" {
  value       = try(google_iam_workload_identity_pool_provider.github_relay_asia_proof[0].name, null)
  description = "Workflow-bound staging Relay Asia proof Workload Identity provider."
}

output "github_relay_asia_proof_service_account" {
  value       = try(google_service_account.github_relay_asia_proof[0].email, null)
  description = "Least-privilege staging Relay Asia proof service account."
}

output "relay_fence_broker_service_uri" {
  value       = try(google_cloud_run_v2_service.relay_fence_broker[0].uri, null)
  description = "IAM-authenticated private Relay fence broker URI."
}

output "relay_fence_broker_service_account" {
  value       = try(google_service_account.relay_fence_broker[0].email, null)
  description = "Runtime identity that owns exact Relay fence mutations."
}


output "relay_cloud_run_service_uri" {
  value       = google_cloud_run_v2_service.relay.uri
  description = "Default relay service URI for pre-domain smoke tests."
}

output "relay_runtime_service_account" {
  value       = google_service_account.relay_runtime.email
  description = "Runtime identity for stamped Relay cells."
}

output "relay_director_runtime_service_account" {
  value       = google_service_account.relay_director_runtime.email
  description = "Runtime and regional rehoming caller identity for the Relay director."
}

output "relay_cell_cloud_run_service_uris" {
  value = {
    for cell_id, service in google_cloud_run_v2_service.relay_cell :
    cell_id => service.uri
  }
  description = "Native Cloud Run URIs for stamped relay cells."
}

output "relay_database_name" {
  value       = google_sql_database.relay.name
  description = "Database isolated for durable relay state."
}

output "relay_gce_load_balancer_ip" {
  value       = try(google_compute_global_address.relay_gce[0].address, null)
  description = "Reserved IPv4 address for the shared GCE relay HTTPS load balancer."
}

output "relay_gce_wildcard_dns_record" {
  value = var.relay_gce_domain == "" ? null : {
    name = "*.${var.relay_gce_domain}"
    type = "A"
    data = try(google_compute_global_address.relay_gce[0].address, null)
  }
  description = "DNS-only wildcard record that routes future cell hosts to the shared LB."
}

output "relay_gce_certificate_dns_authorization" {
  value       = try(google_certificate_manager_dns_authorization.relay_gce[0].dns_resource_record[0], null)
  description = "Certificate Manager DNS record that must remain published for renewal."
}

output "relay_gce_cell_origins" {
  value       = local.relay_gce_cell_urls
  description = "Exact public origins admitted by the shared GCE relay load balancer."
}

output "relay_gce_cell_instance_groups" {
  value = {
    for cell_id, manager in google_compute_instance_group_manager.relay_gce_cell :
    cell_id => manager.instance_group
  }
  description = "Terraform-sized managed instance groups backing each GCE relay cell."
}

output "relay_gce_cell_backend_services" {
  value = {
    for cell_id, backend in google_compute_backend_service.relay_gce_cell :
    cell_id => backend.id
  }
  description = "Non-overlapping backend service for each exact relay cell host."
}

output "relay_gce_cell_deployments" {
  value = {
    for cell_id, cell in var.relay_gce_cells : cell_id => {
      origin                      = local.relay_gce_cell_urls[cell_id]
      region                      = cell.region
      zone                        = cell.zone
      mig_name                    = google_compute_instance_group_manager.relay_gce_cell[cell_id].name
      instance_group              = google_compute_instance_group_manager.relay_gce_cell[cell_id].instance_group
      backend_name                = google_compute_backend_service.relay_gce_cell[cell_id].name
      backend_id                  = google_compute_backend_service.relay_gce_cell[cell_id].id
      url_map_name                = google_compute_url_map.relay_gce[0].name
      generation_identity         = google_compute_instance_template.relay_gce_cell[cell_id].self_link
      image                       = cell.image
      capacity_requests           = cell.capacity_requests
      database_pool_max           = cell.database_pool_max
      connection_hard_cap         = cell.connection_hard_cap
      connection_unobserved_bound = cell.connection_unobserved_bound
      initially_enabled           = cell.initially_enabled
      fenced                      = contains(var.relay_gce_fenced_cells, cell_id)
      desired_target_size         = local.relay_gce_cell_target_sizes[cell_id]
      target_size                 = google_compute_instance_group_manager.relay_gce_cell[cell_id].target_size
    }
  }
  description = "Non-secret candidate deployment topology consumed by the GCE preflight workflow."

  precondition {
    condition = alltrue([
      for cell_id in var.relay_gce_fenced_cells : contains(keys(var.relay_gce_cells), cell_id)
    ])
    error_message = "relay_gce_fenced_cells may contain only configured relay_gce_cells keys."
  }
}
