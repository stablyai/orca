import type { ProviderViewProjectionModel } from '../project-board/use-mobile-tasks-provider-view-projection'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { useThemedStyles } from '../../theme/themed-styles'
import {
  composerInputStylesSheet,
  groupFieldStylesSheet
} from '../../components/composer-input/composer-input-styles'
import { stylesSheet } from '../mobile-tasks-legacy-styles'
import { classifyConnection } from '../../transport/connection/connection-health'
import { providerEmptyLabel } from '../task-list/mobile-task-view-options'
import { getTaskPresetQuery } from '../../../../src/shared/work-items/task-preset-query'

export function useMobileTasksConnectionPresentation(model: ProviderViewProjectionModel) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const composerInputStyles = useThemedStyles(composerInputStylesSheet)
  const groupFieldStyles = useThemedStyles(groupFieldStylesSheet)
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
  const headerVerdict = classifyConnection(
    {
      state: connState,
      reconnectAttempts,
      lastConnectedAt,
      ...relayRecovery
    },
    t
  )
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
        : providerEmptyLabel(t, provider)
  // Until the first read settles, an empty list is unread, not empty: keep the spinner up.
  const loading =
    model.loading || (connState === 'connected' && !model.taskListSettled && !model.error)
  // Before Tasks is ready (connecting, offline, or waiting on its first read), the last list stays up, read-only.
  // A failed first read on a live connection shows its error and Retry instead.
  const showsKeptRows =
    !model.tasksSupported &&
    !model.tasksUnsupported &&
    !isGithubProjectSearch &&
    !(connState === 'connected' && model.error) &&
    model.items.length > 0
  return {
    ...model,
    colors,
    composerInputStyles,
    groupFieldStyles,
    styles,
    t,
    headerVerdict,
    emptyLabel,
    hasSearch,
    isGithubProjectSearch,
    loading,
    showsKeptRows
  }
}

export type ConnectionPresentationModel = ReturnType<typeof useMobileTasksConnectionPresentation>
