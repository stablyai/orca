import type { ProviderViewProjectionModel } from './use-mobile-tasks-provider-view-projection'
import { classifyConnection } from './mobile-tasks-dependencies'
import { PROVIDER_EMPTY_LABELS } from './mobile-task-view-options'
import { getTaskPresetQuery } from './mobile-tasks-legacy-foundation'

export function useMobileTasksConnectionPresentation(model: ProviderViewProjectionModel) {
  const {
    connState,
    githubMode,
    githubPreset,
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
  // GitHub seeds the field with its preset's query, so only text beyond that is a search.
  const hasUserQuery =
    provider === 'github' && githubMode !== 'project'
      ? query.trim() !== getTaskPresetQuery(githubPreset).trim()
      : query.trim().length > 0
  const emptyLabel =
    connState !== 'connected'
      ? 'Connect to your desktop to load tasks'
      : hasUserQuery
        ? 'No matching tasks'
        : PROVIDER_EMPTY_LABELS[provider]
  const isGithubProjectSearch = provider === 'github' && githubMode === 'project'
  return Object.assign(model, {
    headerVerdict,
    emptyLabel,
    hasUserQuery,
    isGithubProjectSearch
  })
}

export type ConnectionPresentationModel = ReturnType<typeof useMobileTasksConnectionPresentation>
