import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  TaskProviderLogo,
  colors,
  Text,
  Pressable,
  ChevronDown,
  TextInput,
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
          <Text style={styles.sheetTitle}>New {providerLabel} Issue</Text>
        </View>
        <Text style={styles.sheetSubtitle}>
          {provider === 'github' || provider === 'gitlab'
            ? 'Create an issue in the selected repository.'
            : 'Create an issue in the selected Linear team.'}
        </Text>
      </View>

      <View style={styles.createForm}>
        <Text style={styles.fieldLabel}>
          {provider === 'github' || provider === 'gitlab' ? 'Repository' : 'Team'}
        </Text>
        <Pressable
          style={styles.targetButton}
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
                        selectedCreateTarget as RepoSummary,
                        (selectedCreateTarget as RepoSummary).displayName
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
            <Text style={styles.fieldLabel}>Issue source</Text>
            <Text style={styles.issueSourceHint} numberOfLines={2}>
              File in{' '}
              {selectedCreateIssuePreference === 'origin'
                ? issueSourceSlug(selectedCreateGitHubSources?.prs)
                : issueSourceSlug(selectedCreateGitHubSources?.upstreamCandidate)}
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
                      {preference === 'upstream' ? 'Upstream' : 'Origin'}
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

        <Text style={styles.fieldLabel}>Title</Text>
        <TextInput
          style={styles.input}
          value={createTitle}
          onChangeText={setCreateTitle}
          placeholder="Task title"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="sentences"
          returnKeyType="next"
        />

        <Text style={styles.fieldLabel}>Description</Text>
        <TextInput
          style={[styles.input, styles.bodyInput]}
          value={createBody}
          onChangeText={setCreateBody}
          placeholder="Add context"
          placeholderTextColor={colors.textMuted}
          multiline
          textAlignVertical="top"
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
            <Text style={styles.createButtonText}>Create Issue</Text>
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
      title={provider === 'linear' ? 'Linear Team' : 'Repository'}
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
          <Text style={styles.sheetTitle}>Connect Linear workspace</Text>
        </View>
        <Text style={styles.sheetSubtitle}>
          Paste a Personal API key to browse issues from that workspace.
        </Text>
      </View>
      <View style={styles.createForm}>
        <Text style={styles.fieldLabel}>Personal API key</Text>
        <TextInput
          style={styles.input}
          value={linearApiKeyDraft}
          onChangeText={(next) => {
            setLinearApiKeyDraft(next)
            if (linearConnectState === 'error') {
              setLinearConnectState('idle')
              setLinearConnectError('')
            }
          }}
          placeholder="lin_api_..."
          placeholderTextColor={colors.textMuted}
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
          <Text style={styles.inlineTextLinkText}>Linear Settings / Security / New API key</Text>
        </Pressable>
        <View style={styles.securityHintRow}>
          <Lock size={13} color={colors.textMuted} />
          <Text style={styles.securityHintText}>
            Your key is encrypted via the host OS keychain and stored locally.
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
            <Text style={styles.createButtonText}>Connect</Text>
          )}
        </Pressable>
      </View>
    </BottomDrawer>
  )
}

export function renderMobileTasksWorkspaceCreateTargetPicker(model: ConnectionPresentationModel) {
  const {
    openWorkspaceCreate,
    setWorkspaceRepoPickerItem,
    taskUiReady,
    workspaceRepoOptions,
    workspaceRepoPickerItem,
    workspaceRepos
  } = model
  return (
    <PickerModal
      visible={taskUiReady && workspaceRepoPickerItem != null}
      title="Create Workspace In"
      options={workspaceRepoOptions}
      selected={workspaceRepos[0]?.id ?? ''}
      onSelect={(repoId) => {
        if (workspaceRepoPickerItem) {
          openWorkspaceCreate(workspaceRepoPickerItem, repoId)
        }
        setWorkspaceRepoPickerItem(null)
      }}
      onClose={() => setWorkspaceRepoPickerItem(null)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
    />
  )
}
