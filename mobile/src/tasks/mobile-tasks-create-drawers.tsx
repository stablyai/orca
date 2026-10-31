import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import {
  BottomDrawer,
  View,
  TaskProviderLogo,
  colors,
  Text,
  Pressable,
  ChevronDown,
  MessageBox,
  TextField,
  ActivityIndicator,
  PickerModal,
  Linking,
  ExternalLink,
  Lock
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import {
  getRepoBadgeColor,
  type RepoSummary,
  hasGitHubIssueSourceChoice,
  issueSourceSlug,
  type LinearTeam,
  TASK_SECONDARY_DRAWER_Z_INDEX
} from './mobile-tasks-legacy-foundation'

export function renderMobileTasksCreateDrawer(model: ConnectionPresentationModel) {
  const {
    createBody,
    createTask,
    createTitle,
    creatingTask,
    provider,
    providerLabel,
    selectedCreateGitHubSources,
    selectedCreateIssuePreference,
    selectedCreateRepo,
    selectedCreateTarget,
    selectedCreateTargetLabel,
    setCreateBody,
    setCreateTitle,
    setGitHubIssueSourcePreference,
    setShowCreateTargetPicker,
    setShowCreateTask,
    showCreateTask,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showCreateTask}
      onClose={() => {
        setShowCreateTargetPicker(false)
        setShowCreateTask(false)
      }}
    >
      <View style={styles.sheetHeader}>
        <View style={styles.sheetTitleRow}>
          <TaskProviderLogo provider={provider} size={16} color={colors.textPrimary} />
          <Text style={styles.sheetTitle}>
            {translate('tasks.tasksCreateDrawers.newIssueTitle', 'New {{providerLabel}} Issue', {
              providerLabel
            })}
          </Text>
        </View>
        <Text style={styles.sheetSubtitle}>
          {provider === 'github' || provider === 'gitlab'
            ? translate(
                'tasks.tasksCreateDrawers.repositorySubtitle',
                'Create an issue in the selected repository.'
              )
            : translate(
                'tasks.tasksCreateDrawers.linearTeamSubtitle',
                'Create an issue in the selected Linear team.'
              )}
        </Text>
      </View>

      <View style={styles.createForm}>
        <Text style={styles.fieldLabel}>
          {provider === 'github' || provider === 'gitlab'
            ? translate('tasks.tasksCreateDrawers.repository', 'Repository')
            : translate('tasks.tasksCreateDrawers.team', 'Team')}
        </Text>
        <Pressable
          style={[styles.targetButton, styles.targetButtonOnSheet]}
          disabled={!taskUiReady}
          onPress={() => {
            if (!taskUiReady) {
              return
            }
            setShowCreateTargetPicker(true)
          }}
        >
          {provider === 'github' || provider === 'gitlab' ? (
            <View
              style={[
                styles.pickerRepoDot,
                selectedCreateTarget
                  ? {
                      backgroundColor: getRepoBadgeColor(
                        'badgeColor' in selectedCreateTarget ? selectedCreateTarget : undefined
                      )
                    }
                  : undefined
              ]}
            />
          ) : null}
          <Text style={styles.targetButtonText} numberOfLines={1}>
            {selectedCreateTargetLabel}
          </Text>
          <ChevronDown size={14} color={colors.textMuted} />
        </Pressable>

        {provider === 'github' &&
        selectedCreateRepo &&
        hasGitHubIssueSourceChoice(selectedCreateGitHubSources) ? (
          <View style={styles.issueSourceBox}>
            <Text style={styles.fieldLabel}>
              {translate('tasks.tasksCreateDrawers.issueSource', 'Issue source')}
            </Text>
            <Text style={styles.issueSourceHint} numberOfLines={2}>
              {translate('tasks.tasksCreateDrawers.fileIn', 'File in {{slug}}', {
                slug:
                  selectedCreateIssuePreference === 'origin'
                    ? issueSourceSlug(selectedCreateGitHubSources?.prs)
                    : issueSourceSlug(selectedCreateGitHubSources?.upstreamCandidate)
              })}
            </Text>
            <View style={styles.issueSourceSegment}>
              {(['upstream', 'origin'] as const).map((preference) => {
                const selected = selectedCreateIssuePreference === preference
                const slug =
                  preference === 'upstream'
                    ? issueSourceSlug(selectedCreateGitHubSources?.upstreamCandidate)
                    : issueSourceSlug(selectedCreateGitHubSources?.prs)
                return (
                  <Pressable
                    key={preference}
                    style={[
                      styles.issueSourceSegmentButton,
                      selected && styles.issueSourceSegmentButtonActive
                    ]}
                    accessibilityState={{ selected }}
                    onPress={() =>
                      void setGitHubIssueSourcePreference(selectedCreateRepo, preference)
                    }
                  >
                    <Text
                      style={[
                        styles.issueSourceSegmentText,
                        selected && styles.issueSourceSegmentTextActive
                      ]}
                    >
                      {preference === 'upstream'
                        ? translate('tasks.tasksCreateDrawers.upstream', 'Upstream')
                        : translate('tasks.tasksCreateDrawers.origin', 'Origin')}
                    </Text>
                    <Text style={styles.issueSourceSlug} numberOfLines={1}>
                      {slug}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          </View>
        ) : null}

        <Text style={styles.fieldLabel}>
          {translate('tasks.tasksCreateDrawers.title', 'Title')}
        </Text>
        <TextField
          value={createTitle}
          onChangeText={setCreateTitle}
          placeholder={translate('tasks.tasksCreateDrawers.titlePlaceholder', 'Task title')}
          autoCapitalize="sentences"
          returnKeyType="next"
        />

        <Text style={styles.fieldLabel}>
          {translate('tasks.tasksCreateDrawers.description', 'Description')}
        </Text>
        <MessageBox
          value={createBody}
          onChangeText={setCreateBody}
          placeholder={translate('tasks.tasksCreateDrawers.descriptionPlaceholder', 'Add context')}
        />

        <Pressable
          style={[
            styles.createButton,
            (!taskUiReady || !createTitle.trim() || creatingTask) && styles.createButtonDisabled
          ]}
          disabled={!taskUiReady || !createTitle.trim() || creatingTask}
          onPress={() => void createTask()}
        >
          {creatingTask ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <Text style={styles.createButtonText}>
              {translate('tasks.tasksCreateDrawers.createIssue', 'Create Issue')}
            </Text>
          )}
        </Pressable>
      </View>
    </BottomDrawer>
  )
}

export function renderMobileTasksCreateTargetPicker(model: ConnectionPresentationModel) {
  const {
    createTargetOptions,
    provider,
    selectedCreateTarget,
    setCreateRepoId,
    setCreateTeamId,
    setShowCreateTargetPicker,
    showCreateTargetPicker,
    showCreateTask,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showCreateTask && showCreateTargetPicker}
      title={
        provider === 'linear'
          ? translate('tasks.tasksCreateDrawers.linearTeam', 'Linear Team')
          : translate('tasks.tasksCreateDrawers.repository', 'Repository')
      }
      options={createTargetOptions}
      selected={
        provider === 'github' || provider === 'gitlab'
          ? ((selectedCreateTarget as RepoSummary | null)?.id ?? '')
          : ((selectedCreateTarget as LinearTeam | null)?.id ?? '')
      }
      onSelect={(value) => {
        if (provider === 'github' || provider === 'gitlab') {
          setCreateRepoId(value)
        } else {
          setCreateTeamId(value)
        }
      }}
      onClose={() => setShowCreateTargetPicker(false)}
    />
  )
}

export function renderMobileTasksLinearConnectDrawer(model: ConnectionPresentationModel) {
  const {
    connectLinearAccount,
    linearApiKeyDraft,
    linearConnectError,
    linearConnectState,
    setLinearApiKeyDraft,
    setLinearConnectError,
    setLinearConnectState,
    setShowLinearConnect,
    showLinearConnect,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showLinearConnect}
      onClose={() => {
        if (linearConnectState !== 'connecting') {
          setShowLinearConnect(false)
        }
      }}
    >
      <View style={styles.sheetHeader}>
        <View style={styles.sheetTitleRow}>
          <TaskProviderLogo provider="linear" size={16} color={colors.textPrimary} />
          <Text style={styles.sheetTitle}>
            {translate(
              'tasks.tasksCreateDrawers.connectLinearWorkspace',
              'Connect Linear workspace'
            )}
          </Text>
        </View>
        <Text style={styles.sheetSubtitle}>
          {translate(
            'tasks.tasksCreateDrawers.linearConnectSubtitle',
            'Paste a Personal API key to browse issues from that workspace.'
          )}
        </Text>
      </View>
      <View style={styles.createForm}>
        <Text style={styles.fieldLabel}>
          {translate('tasks.tasksCreateDrawers.personalApiKey', 'Personal API key')}
        </Text>
        <TextField
          value={linearApiKeyDraft}
          onChangeText={(next) => {
            setLinearApiKeyDraft(next)
            if (linearConnectState === 'error') {
              setLinearConnectState('idle')
              setLinearConnectError('')
            }
          }}
          placeholder="lin_api_..."
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          editable={linearConnectState !== 'connecting'}
          onSubmitEditing={() => void connectLinearAccount()}
        />
        {linearConnectState === 'error' && linearConnectError ? (
          <Text style={styles.detailError}>{linearConnectError}</Text>
        ) : null}
        <Pressable
          style={styles.inlineTextLink}
          onPress={() => void Linking.openURL('https://linear.app/settings/account/security')}
        >
          <ExternalLink size={13} color={colors.textSecondary} />
          <Text style={styles.inlineTextLinkText}>
            {translate(
              'tasks.tasksCreateDrawers.linearSettingsLink',
              'Linear Settings / Security / New API key'
            )}
          </Text>
        </Pressable>
        <View style={styles.securityHintRow}>
          <Lock size={13} color={colors.textMuted} />
          <Text style={styles.securityHintText}>
            {translate(
              'tasks.tasksCreateDrawers.keySecurityHint',
              'Your key is encrypted via the host OS keychain and stored locally.'
            )}
          </Text>
        </View>
        <Pressable
          style={[
            styles.createButton,
            (!linearApiKeyDraft.trim() || linearConnectState === 'connecting') &&
              styles.createButtonDisabled
          ]}
          disabled={!linearApiKeyDraft.trim() || linearConnectState === 'connecting'}
          onPress={() => void connectLinearAccount()}
        >
          {linearConnectState === 'connecting' ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <Text style={styles.createButtonText}>
              {translate('tasks.tasksCreateDrawers.connect', 'Connect')}
            </Text>
          )}
        </Pressable>
      </View>
    </BottomDrawer>
  )
}

export function renderMobileTasksWorkspaceCreateTargetPicker(model: ConnectionPresentationModel) {
  const {
    openWorkspaceCreate,
    repoPickerHandoff,
    taskUiReady,
    workspaceRepoOptions,
    workspaceRepoPickerItem,
    workspaceRepos
  } = model
  return (
    <PickerModal
      visible={taskUiReady && workspaceRepoPickerItem != null}
      title={translate('tasks.tasksCreateDrawers.createWorkspaceIn', 'Create Workspace In')}
      options={workspaceRepoOptions}
      selected={workspaceRepos[0]?.id ?? ''}
      onSelect={(repoId) => {
        if (workspaceRepoPickerItem) {
          const item = workspaceRepoPickerItem
          repoPickerHandoff.closeThen(() => openWorkspaceCreate(item, repoId))
        }
      }}
      {...repoPickerHandoff.drawerProps}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
    />
  )
}
