import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { Pressable, Text } from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'

// Multiple connected sites add a scope picker beside the issue filter.
export function renderMobileTasksJiraViewControls(model: ConnectionPresentationModel) {
  const {
    provider,
    jiraConnection,
    jiraFilterLabel,
    jiraSiteChipLabel,
    appliedQuery,
    taskUiReady,
    setShowJiraSitePicker,
    setShowJiraFilterPicker
  } = model
  if (provider !== 'jira' || !jiraConnection.connected) {
    return null
  }
  const queryOverridesPreset = appliedQuery.trim().length > 0
  return (
    <>
      {jiraConnection.sites.length > 1 ? (
        <Pressable
          style={styles.segmentButton}
          disabled={!taskUiReady}
          onPress={() => {
            if (taskUiReady) {
              setShowJiraSitePicker(true)
            }
          }}
        >
          <Text style={styles.segmentSecondaryText}>{jiraSiteChipLabel}</Text>
        </Pressable>
      ) : null}
      <Pressable
        style={styles.segmentButton}
        disabled={!taskUiReady || queryOverridesPreset}
        onPress={() => {
          if (taskUiReady) {
            setShowJiraFilterPicker(true)
          }
        }}
      >
        <Text
          style={[
            styles.segmentSecondaryText,
            queryOverridesPreset ? styles.segmentDisabledText : null
          ]}
        >
          {jiraFilterLabel}
        </Text>
      </Pressable>
    </>
  )
}
