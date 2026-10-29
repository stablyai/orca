import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import { Pressable, Text, View, Linking, ExternalLink, colors } from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'

export function renderMobileTasksGitHubViewControls(model: ConnectionPresentationModel) {
  const {
    activeGitHubProjectView,
    activeProjectLabel,
    githubIssueSourceLabel,
    githubIssueSourceRows,
    githubMode,
    githubModeLabel,
    githubPresetLabel,
    githubProjectAvailableSummaryFields,
    githubProjectFieldsLabel,
    githubProjectSortLabel,
    githubProjectTable,
    provider,
    selectedGitHubProjectViewUrl,
    setShowGitHubIssueSourcePicker,
    setShowGitHubKindPicker,
    setShowGitHubPresetPicker,
    setShowGitHubProjectFieldsPicker,
    setShowGitHubProjectPicker,
    setShowGitHubProjectSortPicker,
    setShowGitHubProjectViewPicker,
    taskUiReady,
    visibleGitHubProjectRows
  } = model
  return (
    provider === 'github' && (
      <>
        <Pressable
          style={styles.segmentButton}
          disabled={!taskUiReady}
          onPress={() => {
            if (!taskUiReady) {
              return
            }
            setShowGitHubKindPicker(true)
          }}
        >
          <Text style={styles.segmentSecondaryText}>{githubModeLabel}</Text>
        </Pressable>
        {githubMode === 'items' ? (
          <>
            <Pressable
              style={styles.segmentButton}
              disabled={!taskUiReady}
              onPress={() => {
                if (!taskUiReady) {
                  return
                }
                setShowGitHubPresetPicker(true)
              }}
            >
              <Text style={styles.segmentSecondaryText}>{githubPresetLabel}</Text>
            </Pressable>
            {githubIssueSourceRows.length > 0 ? (
              <Pressable
                style={styles.segmentButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  setShowGitHubIssueSourcePicker(true)
                }}
              >
                <Text style={styles.segmentSecondaryText}>
                  {translate('tasks.githubViewControls.source', 'Source: {{source}}', {
                    source: githubIssueSourceLabel
                  })}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : (
          <>
            <Pressable
              style={styles.segmentButton}
              disabled={!taskUiReady}
              onPress={() => {
                if (!taskUiReady) {
                  return
                }
                setShowGitHubProjectPicker(true)
              }}
            >
              <Text style={styles.segmentSecondaryText}>{activeProjectLabel}</Text>
            </Pressable>
            {activeGitHubProjectView ? (
              <Pressable
                style={styles.segmentButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  setShowGitHubProjectViewPicker(true)
                }}
              >
                <Text style={styles.segmentSecondaryText}>{activeGitHubProjectView.name}</Text>
              </Pressable>
            ) : null}
            {githubProjectTable ? (
              <Pressable
                style={styles.segmentButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  setShowGitHubProjectSortPicker(true)
                }}
              >
                <Text style={styles.segmentSecondaryText}>
                  {translate('tasks.githubViewControls.sort', 'Sort: {{sort}}', {
                    sort: githubProjectSortLabel
                  })}
                </Text>
              </Pressable>
            ) : null}
            {githubProjectAvailableSummaryFields.length > 0 ? (
              <Pressable
                style={styles.segmentButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  setShowGitHubProjectFieldsPicker(true)
                }}
              >
                <Text style={styles.segmentSecondaryText}>
                  {translate('tasks.githubViewControls.fields', 'Fields: {{fields}}', {
                    fields: githubProjectFieldsLabel
                  })}
                </Text>
              </Pressable>
            ) : null}
            {githubProjectTable ? (
              <View style={styles.segmentCountPill}>
                <Text style={styles.segmentSecondaryText}>{visibleGitHubProjectRows.length}</Text>
              </View>
            ) : null}
            {selectedGitHubProjectViewUrl ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={translate(
                  'tasks.githubViewControls.openView',
                  'Open view in GitHub'
                )}
                style={styles.segmentIconButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  void Linking.openURL(selectedGitHubProjectViewUrl)
                }}
              >
                <ExternalLink size={14} color={colors.textSecondary} />
              </Pressable>
            ) : null}
          </>
        )}
      </>
    )
  )
}
