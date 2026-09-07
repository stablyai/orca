import type { ProviderViewProjectionModel } from './use-mobile-tasks-provider-view-projection'
import { classifyConnection } from './mobile-tasks-dependencies'

export function useMobileTasksConnectionPresentation(model: ProviderViewProjectionModel) {
  const {
    connState,
    githubMode,
    lastConnectedAt,
    provider,
    query,
    reconnectAttempts,
    relayRecovery
  } = model
  const headerVerdict = classifyConnection({
    state: connState,
    reconnectAttempts,
    lastConnectedAt,
    ...relayRecovery
  })
  const emptyLabel =
    connState !== 'connected'
      ? 'Connect to a host to load tasks'
      : query
        ? 'No matching tasks'
        : provider === 'github'
          ? 'No GitHub tasks'
          : provider === 'gitlab'
            ? 'No GitLab tasks'
            : 'No Linear tasks'
  const isGithubProjectSearch = provider === 'github' && githubMode === 'project'
  return Object.assign(model, { headerVerdict, emptyLabel, isGithubProjectSearch })
}

export type ConnectionPresentationModel = ReturnType<typeof useMobileTasksConnectionPresentation>
