import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import { Pressable, Text } from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'

export function renderMobileTasksLinearViewControls(model: ConnectionPresentationModel) {
  const {
    linearConnected,
    linearFilterLabel,
    linearGroupLabel,
    linearOrderLabel,
    linearTeamLabel,
    linearViewLabel,
    linearWorkspaceLabel,
    linearWorkspaces,
    provider,
    setShowLinearDisplayPicker,
    setShowLinearFilterPicker,
    setShowLinearGroupPicker,
    setShowLinearOrderPicker,
    setShowLinearTeamPicker,
    setShowLinearViewPicker,
    setShowLinearWorkspacePicker,
    taskUiReady
  } = model
  return (
    provider === 'linear' &&
    linearConnected && (
      <>
        {linearWorkspaces.length > 1 ? (
          <Pressable
            style={styles.segmentButton}
            disabled={!taskUiReady}
            onPress={() => {
              if (!taskUiReady) {
                return
              }
              setShowLinearWorkspacePicker(true)
            }}
          >
            <Text style={styles.segmentSecondaryText}>{linearWorkspaceLabel}</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={styles.segmentButton}
          disabled={!taskUiReady}
          onPress={() => {
            if (!taskUiReady) {
              return
            }
            setShowLinearTeamPicker(true)
          }}
        >
          <Text style={styles.segmentSecondaryText}>{linearTeamLabel}</Text>
        </Pressable>
        <Pressable
          style={styles.segmentButton}
          disabled={!taskUiReady}
          onPress={() => {
            if (!taskUiReady) {
              return
            }
            setShowLinearFilterPicker(true)
          }}
        >
          <Text style={styles.segmentSecondaryText}>{linearFilterLabel}</Text>
        </Pressable>
        <Pressable
          style={styles.segmentButton}
          disabled={!taskUiReady}
          onPress={() => {
            if (!taskUiReady) {
              return
            }
            setShowLinearViewPicker(true)
          }}
        >
          <Text style={styles.segmentSecondaryText}>{linearViewLabel}</Text>
        </Pressable>
        <Pressable
          style={styles.segmentButton}
          disabled={!taskUiReady}
          onPress={() => {
            if (!taskUiReady) {
              return
            }
            setShowLinearGroupPicker(true)
          }}
        >
          <Text style={styles.segmentSecondaryText}>
            {translate('tasks.linearViewControls.groupLabel', 'Group: {{group}}', {
              group: linearGroupLabel
            })}
          </Text>
        </Pressable>
        <Pressable
          style={styles.segmentButton}
          disabled={!taskUiReady}
          onPress={() => {
            if (!taskUiReady) {
              return
            }
            setShowLinearOrderPicker(true)
          }}
        >
          <Text style={styles.segmentSecondaryText}>
            {translate('tasks.linearViewControls.orderLabel', 'Order: {{order}}', {
              order: linearOrderLabel
            })}
          </Text>
        </Pressable>
        <Pressable
          style={styles.segmentButton}
          disabled={!taskUiReady}
          onPress={() => {
            if (!taskUiReady) {
              return
            }
            setShowLinearDisplayPicker(true)
          }}
        >
          <Text style={styles.segmentSecondaryText}>
            {translate('tasks.linearViewControls.displayButton', 'Display')}
          </Text>
        </Pressable>
      </>
    )
  )
}
