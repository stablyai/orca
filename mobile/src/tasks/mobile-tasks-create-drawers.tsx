import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  colors,
  Text,
  TextInput,
  StyleSheet,
  PickerModal,
  Linking,
  ExternalLink,
  Lock,
  spacing,
  textStyles
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { Button } from '../components/ui/Button'
import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { TextField } from '../components/ui/TextField'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { ISSUE_SOURCE_SEGMENTS } from './mobile-tasks-provider-pickers'
import {
  MobileTasksSheetError,
  MobileTasksSheetHeader,
  sheetStyles
} from './mobile-tasks-sheet-chrome'
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
    error,
    provider,
    providerLabel,
    selectedCreateGitHubSources,
    selectedCreateIssuePreference,
    selectedCreateRepo,
    selectedCreateTarget,
    selectedCreateTargetLabel,
    setCreateBody,
    setCreateTitle,
    setError,
    setGitHubIssueSourcePreference,
    setShowCreateTargetPicker,
    setShowCreateTask,
    showCreateTask,
    taskUiReady
  } = model
  const repoScoped = provider === 'github' || provider === 'gitlab'
  return (
    <BottomDrawer
      visible={taskUiReady && showCreateTask}
      onClose={() => {
        setShowCreateTargetPicker(false)
        setShowCreateTask(false)
      }}
    >
      <MobileTasksSheetHeader
        title={`New ${providerLabel} issue`}
        leading={{
          label: 'Cancel',
          onPress: () => {
            setShowCreateTargetPicker(false)
            setShowCreateTask(false)
          }
        }}
      />
      <MobileTasksSheetError error={error} onDismiss={() => setError('')} />

      <View style={sheetStyles.form}>
        <ListGroup style={createStyles.flushGroup}>
          <ListRow
            title={repoScoped ? 'Repository' : 'Team'}
            value={selectedCreateTargetLabel}
            navigates
            disabled={!taskUiReady}
            leading={
              repoScoped ? (
                <View
                  style={[
                    sheetStyles.dot,
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
              ) : undefined
            }
            onPress={() => setShowCreateTargetPicker(true)}
          />
        </ListGroup>

        {provider === 'github' &&
        selectedCreateRepo &&
        hasGitHubIssueSourceChoice(selectedCreateGitHubSources) ? (
          <View style={styles.issueSourceBox}>
            <Text style={styles.fieldLabel}>Issue source</Text>
            <MobileSegmentedControl
              segments={ISSUE_SOURCE_SEGMENTS}
              selected={selectedCreateIssuePreference}
              onSelect={(preference) =>
                void setGitHubIssueSourcePreference(selectedCreateRepo, preference)
              }
              fill
              testIDPrefix="mobile-tasks-create-issue-source-"
            />
            <Text style={styles.issueSourceHint} numberOfLines={2}>
              Files in{' '}
              {selectedCreateIssuePreference === 'origin'
                ? issueSourceSlug(selectedCreateGitHubSources?.prs)
                : issueSourceSlug(selectedCreateGitHubSources?.upstreamCandidate)}
            </Text>
          </View>
        ) : null}

        <TextField
          label="Title"
          value={createTitle}
          onChangeText={setCreateTitle}
          placeholder="What needs doing?"
          autoCapitalize="sentences"
          returnKeyType="next"
        />

        <View style={createStyles.field}>
          <Text style={styles.fieldLabel}>Description</Text>
          <TextInput
            style={[styles.input, styles.bodyInput]}
            value={createBody}
            onChangeText={setCreateBody}
            placeholder="Add context (optional)"
            placeholderTextColor={colors.textMuted}
            selectionColor={colors.accentBlue}
            accessibilityLabel="Description"
            multiline
            textAlignVertical="top"
          />
        </View>
      </View>

      <View style={sheetStyles.actions}>
        <Button
          label="Create issue"
          variant="primary"
          block
          busy={creatingTask}
          disabled={!taskUiReady || !createTitle.trim()}
          onPress={() => void createTask()}
        />
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
      title={provider === 'linear' ? 'Team' : 'Repository'}
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
  const connecting = linearConnectState === 'connecting'
  return (
    <BottomDrawer
      visible={taskUiReady && showLinearConnect}
      onClose={() => {
        if (!connecting) {
          setShowLinearConnect(false)
        }
      }}
    >
      <MobileTasksSheetHeader
        title="Connect Linear"
        leading={{
          label: 'Cancel',
          disabled: connecting,
          onPress: () => setShowLinearConnect(false)
        }}
      />
      <Text style={createStyles.intro}>
        Paste a personal API key to browse issues from that workspace.
      </Text>
      <View style={sheetStyles.form}>
        <TextField
          label="Personal API key"
          value={linearApiKeyDraft}
          onChangeText={(next) => {
            setLinearApiKeyDraft(next)
            if (linearConnectState === 'error') {
              setLinearConnectState('idle')
              setLinearConnectError('')
            }
          }}
          placeholder="lin_api_…"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          editable={!connecting}
          onSubmitEditing={() => void connectLinearAccount()}
          error={linearConnectState === 'error' && Boolean(linearConnectError)}
          footnote={
            linearConnectState === 'error' && linearConnectError ? linearConnectError : undefined
          }
        />
        <Button
          label="Create a key in Linear settings"
          icon={ExternalLink}
          variant="plain"
          size="compact"
          accessibilityHint="Opens Linear's security settings"
          onPress={() => Linking.openURL('https://linear.app/settings/account/security')}
        />
        <View style={styles.securityHintRow}>
          <Lock size={14} color={colors.textMuted} strokeWidth={2.2} />
          <Text style={styles.securityHintText}>
            Your key is encrypted with your desktop's keychain and stays on your desktop.
          </Text>
        </View>
      </View>
      <View style={sheetStyles.actions}>
        <Button
          label="Connect"
          variant="primary"
          block
          busy={connecting}
          disabled={!linearApiKeyDraft.trim()}
          onPress={() => void connectLinearAccount()}
        />
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
      title="Start workspace in"
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

const createStyles = StyleSheet.create({
  // The form already insets 4; the group sits on the form's edge.
  flushGroup: { marginHorizontal: 0 },
  field: { gap: spacing.sm },
  intro: {
    ...textStyles.callout,
    color: colors.textSecondary,
    paddingHorizontal: spacing.lg - 4,
    marginBottom: spacing.lg
  }
})
