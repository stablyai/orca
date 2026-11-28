import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { useRef, useState } from 'react'
import { View, type TextInputInstance } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { groupFieldStylesSheet } from '../../components/composer-input/composer-input-styles'
import { MessageBox } from '../../components/composer-input/MessageBox'
import { TextField } from '../../components/composer-input/TextField'
import { ListGroup, ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { PickerModal } from '../../components/sheets/PickerModal'
import { openExternalLink } from '../../platform/external-links/external-link'
import { stylesSheet } from '../mobile-tasks-legacy-styles'
import { getRepoBadgeColor } from '../repositories/mobile-tasks-repository-presentation'
import type { RepoSummary, LinearTeam } from '../mobile-tasks-provider-detail-types'
import {
  hasGitHubIssueSourceChoice,
  issueSourceSlug
} from '../item-detail/mobile-tasks-reviewer-linear'
import { TASK_SECONDARY_DRAWER_Z_INDEX } from '../task-list/mobile-tasks-options'
import { useThemedStyles } from '../../theme/themed-styles'

export function renderMobileTasksCreateDrawer(model: ConnectionPresentationModel) {
  return <MobileTasksCreateDrawer model={model} />
}

// New issue, drawn like New bot: Cancel · New issue · Create, then the fields and pickers as one group.
function MobileTasksCreateDrawer({ model }: { model: ConnectionPresentationModel }) {
  const groupFieldStyles = useThemedStyles(groupFieldStylesSheet)
  const styles = useThemedStyles(stylesSheet)
  const {
    createBody,
    createTask,
    createTitle,
    creatingTask,
    provider,
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
  const t = useMobileTranslation()
  const [pickingFileIn, setPickingFileIn] = useState(false)
  const bodyRef = useRef<TextInputInstance>(null)
  const repoProvider = provider === 'github' || provider === 'gitlab'
  const sources =
    provider === 'github' &&
    selectedCreateRepo &&
    hasGitHubIssueSourceChoice(selectedCreateGitHubSources)
      ? selectedCreateGitHubSources
      : null
  const fileInSlug = (preference: 'upstream' | 'origin') =>
    issueSourceSlug(t, preference === 'origin' ? sources?.prs : sources?.upstreamCandidate)
  const close = () => {
    setShowCreateTargetPicker(false)
    setShowCreateTask(false)
  }
  const visible = taskUiReady && showCreateTask
  // The picker only opens from the open sheet; a sheet that closed another way must not bring it back.
  if (!visible && pickingFileIn) {
    setPickingFileIn(false)
  }
  return (
    <>
      <BottomDrawer visible={visible} dismissible={!creatingTask} onClose={close}>
        <SheetHeader
          title={t('tasks.tasksCreateDrawers.newIssue', 'New issue')}
          leading={{
            label: t('common.cancel', 'Cancel'),
            onPress: close,
            disabled: creatingTask
          }}
          trailing={{
            label: t('tasks.tasksCreateDrawers.create', 'Create'),
            onPress: () => void createTask(),
            disabled: !taskUiReady || !createTitle.trim(),
            busy: creatingTask
          }}
        />
        <ListGroup style={groupFieldStyles.underHeader}>
          <MessageBox
            key="title"
            value={createTitle}
            // A title is one line that wraps; Return moves on to the description.
            onChangeText={(next) => setCreateTitle(next.replace(/\n/g, ' '))}
            placeholder={t('tasks.tasksCreateDrawers.title', 'Title')}
            lines={TITLE_LINES}
            autoFocus
            autoCapitalize="sentences"
            returnKeyType="next"
            submitBehavior="submit"
            blurOnSubmit
            onSubmitEditing={() => bodyRef.current?.focus()}
            style={groupFieldStyles.lines}
          />
          <MessageBox
            key="description"
            inputRef={bodyRef}
            value={createBody}
            onChangeText={setCreateBody}
            placeholder={t('tasks.tasksCreateDrawers.description', 'Description')}
            style={groupFieldStyles.lines}
          />
          <ListRow
            key="target"
            title={
              repoProvider
                ? t('tasks.tasksCreateDrawers.repository', 'Repository')
                : t('tasks.tasksCreateDrawers.team', 'Team')
            }
            value={selectedCreateTargetLabel}
            valueIcon={
              repoProvider && selectedCreateTarget && 'badgeColor' in selectedCreateTarget ? (
                <View
                  style={[
                    styles.pickerRepoDot,
                    { backgroundColor: getRepoBadgeColor(selectedCreateTarget) }
                  ]}
                />
              ) : undefined
            }
            navigates
            disabled={!taskUiReady}
            onPress={() => setShowCreateTargetPicker(true)}
          />
          {sources ? (
            <ListRow
              key="file-in"
              title={t('tasks.tasksCreateDrawers.fileInRow', 'File in')}
              value={fileInSlug(selectedCreateIssuePreference)}
              navigates
              onPress={() => setPickingFileIn(true)}
            />
          ) : null}
        </ListGroup>
      </BottomDrawer>
      <PickerModal
        visible={visible && sources !== null && pickingFileIn}
        title={t('tasks.tasksCreateDrawers.fileInRow', 'File in')}
        options={(['upstream', 'origin'] as const).map((preference) => ({
          value: preference,
          label: fileInSlug(preference),
          subtitle:
            preference === 'upstream'
              ? t('tasks.tasksCreateDrawers.upstream', 'Upstream')
              : t('tasks.tasksCreateDrawers.origin', 'Origin')
        }))}
        selected={selectedCreateIssuePreference}
        onSelect={(preference) => {
          if (selectedCreateRepo) {
            void setGitHubIssueSourcePreference(selectedCreateRepo, preference)
          }
        }}
        onClose={() => setPickingFileIn(false)}
      />
    </>
  )
}

const TITLE_LINES = { min: 1, max: 3 }

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
    t,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showCreateTask && showCreateTargetPicker}
      title={
        provider === 'linear'
          ? t('tasks.tasksCreateDrawers.linearTeam', 'Linear Team')
          : t('tasks.tasksCreateDrawers.repository', 'Repository')
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
    groupFieldStyles,
    linearApiKeyDraft,
    linearConnectError,
    linearConnectState,
    setLinearApiKeyDraft,
    setLinearConnectError,
    setLinearConnectState,
    setShowLinearConnect,
    showLinearConnect,
    t,
    taskUiReady
  } = model
  const connecting = linearConnectState === 'connecting'
  const close = () => {
    if (!connecting) {
      setShowLinearConnect(false)
    }
  }
  return (
    <BottomDrawer
      visible={taskUiReady && showLinearConnect}
      dismissible={!connecting}
      onClose={close}
    >
      <SheetHeader
        title={t('tasks.tasksCreateDrawers.connectLinear', 'Connect Linear')}
        leading={{
          label: t('common.cancel', 'Cancel'),
          onPress: close,
          disabled: connecting
        }}
        trailing={{
          label: t('tasks.tasksCreateDrawers.connect', 'Connect'),
          onPress: () => void connectLinearAccount(),
          disabled: !linearApiKeyDraft.trim(),
          busy: connecting
        }}
      />
      <TextField
        value={linearApiKeyDraft}
        onChangeText={(next) => {
          setLinearApiKeyDraft(next)
          if (linearConnectState === 'error') {
            setLinearConnectState('idle')
            setLinearConnectError('')
          }
        }}
        placeholder={t('tasks.tasksCreateDrawers.personalApiKey', 'Personal API key')}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        editable={!connecting}
        onSubmitEditing={() => void connectLinearAccount()}
        style={groupFieldStyles.underHeader}
      />
      {linearConnectState === 'error' && linearConnectError ? (
        <SettingsNote error>{linearConnectError}</SettingsNote>
      ) : (
        <SettingsNote>
          {t(
            'tasks.tasksCreateDrawers.keySecurityHint',
            'Your key is encrypted via the host OS keychain and stored locally.'
          )}
        </SettingsNote>
      )}
      <SettingsSection>
        <ListRow
          title={t('tasks.tasksCreateDrawers.linearSettingsLink', 'Open Linear settings')}
          accent
          accessibilityRole="link"
          onPress={() => void openExternalLink('https://linear.app/settings/account/security')}
        />
      </SettingsSection>
    </BottomDrawer>
  )
}

export function renderMobileTasksWorkspaceCreateTargetPicker(model: ConnectionPresentationModel) {
  const {
    openWorkspaceCreate,
    repoPickerHandoff,
    t,
    taskUiReady,
    workspaceRepoOptions,
    workspaceRepoPickerItem,
    workspaceRepos
  } = model
  return (
    <PickerModal
      visible={taskUiReady && workspaceRepoPickerItem != null}
      title={t('tasks.tasksCreateDrawers.createWorkspaceIn', 'Create Workspace In')}
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
