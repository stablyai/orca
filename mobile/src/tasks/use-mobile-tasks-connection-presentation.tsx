import type { ProviderViewProjectionModel } from './use-mobile-tasks-provider-view-projection'
import { classifyConnection } from './mobile-tasks-dependencies'
import { PROVIDER_EMPTY_LABELS } from './mobile-task-view-options'

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
        : PROVIDER_EMPTY_LABELS[provider]
  const isGithubProjectSearch = provider === 'github' && githubMode === 'project'
  return Object.assign(model, { headerVerdict, emptyLabel, isGithubProjectSearch })
}

export type ConnectionPresentationModel = ReturnType<typeof useMobileTasksConnectionPresentation>
