import type { ProviderViewProjectionModel } from './use-mobile-tasks-provider-view-projection'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { classifyConnection } from './mobile-tasks-dependencies'
import { PROVIDER_EMPTY_LABELS } from './mobile-task-view-options'
import { getTaskPresetQuery } from './mobile-tasks-legacy-foundation'

export function useMobileTasksConnectionPresentation(model: ProviderViewProjectionModel) {
  const t = useMobileTranslation()
  const {
    appliedGithubProjectSearch,
    connState,
    githubMode,
    githubPreset,
    githubProjectSearch,
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
  const isGithubProjectSearch = provider === 'github' && githubMode === 'project'
  // GitHub's preset text is a filter, not a search, so only a changed query counts as one.
  const hasSearch = isGithubProjectSearch
    ? githubProjectSearch.length > 0 || (appliedGithubProjectSearch?.length ?? 0) > 0
    : provider === 'github'
      ? query.trim() !== getTaskPresetQuery(githubPreset).trim()
      : query.trim().length > 0
  const emptyLabel =
    connState !== 'connected'
      ? t('tasks.connectionPresentation.connectToHost', 'Connect to a host to load tasks')
      : hasSearch
        ? t('tasks.connectionPresentation.noMatchingTasks', 'No matching tasks')
        : PROVIDER_EMPTY_LABELS[provider]
  // Until the first read settles, an empty list is unread, not empty: keep the spinner up.
  const loading =
    model.loading || (connState === 'connected' && !model.taskListSettled && !model.error)
  return Object.assign(model, {
    headerVerdict,
    emptyLabel,
    hasSearch,
    isGithubProjectSearch,
    loading
  })
}

export type ConnectionPresentationModel = ReturnType<typeof useMobileTasksConnectionPresentation>
