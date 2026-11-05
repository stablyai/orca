import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import type { CommitMessageAgentEnvironmentResolvers } from './commit-message-agent-environment'
import type { LocalGenerationTarget } from './source-control-text-generation-types'

export function sourceControlSubscriptionTarget(
  target: LocalGenerationTarget,
  params: ResolvedSourceControlAiGenerationParams,
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined,
  validate: () => Promise<boolean>
): LocalGenerationTarget {
  const registration = target.generationRequest
  if (
    !registration ||
    target.wslDistro ||
    !target.env ||
    !resolvers?.prepareTextSubscriptionFailover
  ) {
    return target
  }
  const request = registration.startBudget(target)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(target.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  let subscription
  try {
    subscription = resolvers.prepareTextSubscriptionFailover({
      params,
      cwd: target.cwd,
      env,
      request
    })
  } catch {
    subscription = undefined
  }
  if (!subscription) {
    // Without failover the request keeps its pre-existing single-attempt process and Stop path.
    registration.discardBudget()
    return target
  }
  registration.validateTarget = validate
  return { ...target, request, subscription }
}
