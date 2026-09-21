# The workflow half of every relay Workload Identity condition, one clause per accepted
# repository.
#
# Each provider file builds its own clause list from local.relay_github_workflow_ref_prefixes, so
# a workflow allowlist stays next to the identity it authorizes. This file only names those lists
# and renders them: with a single accepted repository the clause is spliced in unchanged, and with
# more it becomes one parenthesised OR arm per repository, each arm carrying its own repository
# claims. The repository-independent claims (ref, environment, event_name) stay outside the OR in
# the provider blocks.
locals {
  relay_github_workflow_clauses = {
    github                           = local.github_production_relay_workflow_clauses
    github_monitor                   = local.github_monitor_workflow_clauses
    github_fence                     = local.github_fence_workflow_clauses
    github_production_relay_capacity = local.github_production_relay_capacity_workflow_clauses
    github_staging_relay_capacity    = local.github_staging_relay_capacity_workflow_clauses
    github_staging_relay_deploy      = local.github_staging_relay_deploy_workflow_clauses
    github_relay_asia_topology       = local.github_relay_asia_topology_workflow_clauses
    github_relay_asia_proof          = local.github_relay_asia_proof_workflow_clauses
  }

  relay_github_workflow_arms = {
    for name, clauses in local.relay_github_workflow_clauses :
    name => [
      for index, clause in clauses :
      "(${local.relay_github_accepted_repository_claims[index]} && ${clause})"
    ]
  }

  relay_github_workflow_conditions = {
    for name, clauses in local.relay_github_workflow_clauses :
    name => (
      local.relay_github_single_repository
      ? clauses[0]
      : "(${join(" || ", local.relay_github_workflow_arms[name])})"
    )
  }
}
