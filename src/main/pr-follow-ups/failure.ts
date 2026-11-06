import { formatAgentTypeLabel } from '../../shared/agent-status/presentation/agent-type-label'

export function followUpFailureCopy(
  agent: string,
  error: unknown,
  stage: 'recipe' | 'prepare' | 'launch' = 'launch'
): string {
  const label = formatAgentTypeLabel(agent)
  const code =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined
  if (code === 'agent_launch_surface_unavailable') {
    return `${label} could not start in the selected surface. Choose an available surface in Source Control AI settings, then use Fix checks.`
  }
  if (code === 'agent_launch_target_forbidden' || code === 'agent_launch_target_not_found') {
    return `${label} could not open this workspace. Reopen the workspace, then use Fix checks.`
  }
  if (
    stage === 'recipe' ||
    (error instanceof Error &&
      error.message === 'Choose an agent for Fix failing checks in Source Control AI settings')
  ) {
    return `${label} could not prepare the check fix. Review the Fix checks recipe in Source Control AI settings, then use Fix checks.`
  }
  if (stage === 'prepare') {
    return `${label} could not load the check-fix prompt. Check your connection, then use Fix checks.`
  }
  return `${label} could not start the check fix. Review its setup in Source Control AI settings, then use Fix checks.`
}
