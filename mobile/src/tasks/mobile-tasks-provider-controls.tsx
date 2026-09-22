import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  ScrollView,
  Pressable,
  TaskProviderLogo,
  colors,
  Text,
  View,
  GitBranch
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { getRepoBadgeColor } from './mobile-tasks-legacy-foundation'
import { renderMobileTasksGitHubViewControls } from './mobile-tasks-github-view-controls'
import { renderMobileTasksLinearViewControls } from './mobile-tasks-linear-view-controls'

export function renderMobileTasksProviderControls(model: ConnectionPresentationModel) {
  const {
    githubMode,
    gitlabFilterLabel,
    gitlabView,
    provider,
    providerLabel,
    repoPickerLabel,
    repoPickerSelectedRepo,
    setShowGitLabFilterPicker,
    setShowGitLabViewPicker,
    setShowProviderPicker,
    setShowRepoPicker,
    setShowSortPicker,
    sortLabel,
    taskUiReady
  } = model
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.toolbarScroll}
      contentContainerStyle={styles.toolbar}
    >
      <Pressable
        style={styles.segmentButton}
        disabled={!taskUiReady}
        onPress={() => {
          if (!taskUiReady) {
            return
          }
          setShowProviderPicker(true)
        }}
      >
        <TaskProviderLogo provider={provider} size={14} color={colors.textPrimary} />
        <Text style={styles.segmentButtonText}>{providerLabel}</Text>
      </Pressable>

      {provider === 'gitlab' || (provider === 'github' && githubMode !== 'project') ? (
        <Pressable
          style={styles.segmentButton}
          disabled={!taskUiReady}
          onPress={() => {
            if (!taskUiReady) {
              return
            }
            setShowRepoPicker(true)
          }}
        >
          {repoPickerSelectedRepo ? (
            <View
              style={[
                styles.segmentRepoDot,
                {
                  backgroundColor: getRepoBadgeColor(
                    repoPickerSelectedRepo,
                    repoPickerSelectedRepo.displayName
                  )
                }
              ]}
            />
          ) : null}
          <Text style={styles.segmentSecondaryText}>{repoPickerLabel}</Text>
        </Pressable>
      ) : null}

      {renderMobileTasksGitHubViewControls(model)}

      {provider === 'gitlab' && (
        <>
          <Pressable
            style={styles.segmentButton}
            disabled={!taskUiReady}
            onPress={() => {
              if (!taskUiReady) {
                return
              }
              setShowGitLabViewPicker(true)
            }}
          >
            <Text style={styles.segmentSecondaryText}>
              {gitlabView === 'project' ? 'Project MRs' : 'My Todos'}
            </Text>
          </Pressable>
          {gitlabView === 'project' && (
            <Pressable
              style={styles.segmentButton}
              disabled={!taskUiReady}
              onPress={() => {
                if (!taskUiReady) {
                  return
                }
                setShowGitLabFilterPicker(true)
              }}
            >
              <Text style={styles.segmentSecondaryText}>{gitlabFilterLabel}</Text>
            </Pressable>
          )}
        </>
      )}

      {renderMobileTasksLinearViewControls(model)}

      {provider !== 'linear' && !(provider === 'github' && githubMode === 'project') ? (
        <Pressable
          style={styles.segmentButton}
          disabled={!taskUiReady}
          onPress={() => {
            if (!taskUiReady) {
              return
            }
            setShowSortPicker(true)
          }}
        >
          <GitBranch size={14} color={colors.textSecondary} />
          <Text style={styles.segmentSecondaryText}>Sort: {sortLabel}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  )
}
