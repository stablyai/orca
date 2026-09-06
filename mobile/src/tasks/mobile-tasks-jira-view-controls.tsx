import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { Pressable, Text } from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'

// Jira's toolbar chips: a site chip once more than one site is connected, plus the
// preset chip. A typed JQL query replaces the preset entirely, so the chip dims
// rather than implying both are applied.
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
