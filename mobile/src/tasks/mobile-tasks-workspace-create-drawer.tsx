import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  Text,
  MobileWorkspaceNameInput,
  MobileAgentIcon,
  workspaceAgentLabel,
  PickerModal
} from './mobile-tasks-dependencies'
import { AutoHeight } from '../components/AutoHeight'
import { LIST_LEADING_INSET, ListGroup } from '../components/list/ListGroup'
import { ListRow } from '../components/list/ListRow'
import { SectionHeader } from '../components/list/SectionHeader'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../components/SheetPrimaryButton'
import {
  TASK_SECONDARY_DRAWER_Z_INDEX,
  getRepoBadgeColor,
  workspaceAgentIconId
} from './mobile-tasks-legacy-foundation'
import { newWorktreeFormStyles as styles } from '../components/new-worktree-form-styles'
import { NewWorkspaceSshConnectionField } from '../components/NewWorkspaceSshConnectionField'
import { translate } from '../i18n/mobile-i18n'

export function renderMobileTasksWorkspaceCreateDrawer(model: ConnectionPresentationModel) {
  const {
    connectWorkspaceSshRepo,
    createWorkspace,
    creatingKey,
    handleWorkspaceNameDraftChange,
    resolvedWorkspaceAgent,
    setShowWorkspaceAdvanced,
    setShowWorkspaceAgentPicker,
    setShowWorkspaceBaseBranchPicker,
    setShowWorkspaceCreateRepoPicker,
    setWorkspaceBaseBranchQuery,
    setWorkspaceCreateDraft,
    showWorkspaceAdvanced,
    taskUiReady,
    workspaceAgentDetectionPending,
    workspaceBaseBranch,
    workspaceBranchAutoName,
    workspaceBranchNameOverride,
    workspaceCreateCanPickRepo,
    workspaceCreateDraft,
    workspaceCreateRequiresSshConnection,
    workspaceCreateSshGate,
    workspaceCreateTargetConnectionId,
    workspaceCreateTargetRepo,
    workspaceNameDraft
  } = model
  const closeDrawer = () => setWorkspaceCreateDraft(null)
  const repositoryTitle = translate('tasks.workspaceCreateDrawer.repository', 'Repository')
  const agentTitle = translate('tasks.workspaceCreateDrawer.agent', 'Agent')
  const repositoryValue =
    workspaceCreateTargetRepo?.displayName ??
    translate('tasks.workspaceCreateDrawer.selectRepository', 'Select a repository')
  const agentValue = workspaceCreateRequiresSshConnection
    ? translate('tasks.workspaceCreateDrawer.connectFirst', 'Connect repository first')
    : workspaceAgentDetectionPending
      ? translate('tasks.workspaceCreateDrawer.detectingAgents', 'Detecting agents...')
      : workspaceAgentLabel(resolvedWorkspaceAgent)
  const creating = workspaceCreateDraft != null && creatingKey === workspaceCreateDraft.item.key
  return (
    <BottomDrawer
      visible={taskUiReady && workspaceCreateDraft != null}
      onClose={closeDrawer}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
    >
      {workspaceCreateDraft ? (
        <View>
          <View style={styles.header}>
            <SheetHeader
              title={translate('tasks.workspaceCreateDrawer.title', 'Create Workspace')}
              subtitle={workspaceCreateDraft.item.title}
              leading={{ label: translate('common.cancel', 'Cancel'), onPress: closeDrawer }}
            />
          </View>

          <ListGroup separatorInset={LIST_LEADING_INSET}>
            <ListRow
              key="repository"
              title={repositoryTitle}
              value={repositoryValue}
              leading={
                workspaceCreateTargetRepo ? (
                  <View
                    style={[
                      styles.repoDot,
                      { backgroundColor: getRepoBadgeColor(workspaceCreateTargetRepo) }
                    ]}
                  />
                ) : null
              }
              navigates={workspaceCreateCanPickRepo}
              onPress={
                workspaceCreateCanPickRepo
                  ? () => setShowWorkspaceCreateRepoPicker(true)
                  : undefined
              }
              accessibilityLabel={`${repositoryTitle}, ${repositoryValue}`}
            />
            <ListRow
              key="agent"
              title={agentTitle}
              value={agentValue}
              leading={
                <MobileAgentIcon agentId={workspaceAgentIconId(resolvedWorkspaceAgent)} size={20} />
              }
              navigates
              disabled={workspaceCreateRequiresSshConnection}
              onPress={() => setShowWorkspaceAgentPicker(true)}
              accessibilityLabel={`${agentTitle}, ${agentValue}`}
            />
          </ListGroup>

          {workspaceCreateTargetConnectionId ? (
            <NewWorkspaceSshConnectionField
              repoName={
                workspaceCreateTargetRepo?.displayName ??
                translate('tasks.workspaceCreateDrawer.remoteRepository', 'Remote repository')
              }
              sshGate={workspaceCreateSshGate}
              onConnect={() => void connectWorkspaceSshRepo()}
            />
          ) : null}

          <SectionHeader
            title={translate('tasks.workspaceCreateDrawer.workspaceName', 'Workspace Name')}
            trailing={translate('tasks.workspaceCreateDrawer.optionalLabel', 'Optional')}
          />
          <MobileWorkspaceNameInput
            value={workspaceNameDraft}
            onChangeText={handleWorkspaceNameDraftChange}
            shouldAutoFocus={taskUiReady && workspaceCreateDraft !== null}
          />

          <SectionHeader
            title={translate('tasks.workspaceCreateDrawer.advanced', 'Advanced')}
            expanded={showWorkspaceAdvanced}
            onToggle={() => setShowWorkspaceAdvanced((current) => !current)}
          />
          <AutoHeight>
            {showWorkspaceAdvanced ? (
              <ListGroup>
                <ListRow
                  key="startFrom"
                  title={translate('tasks.workspaceCreateDrawer.startFrom', 'Start from')}
                  value={
                    workspaceBaseBranch?.refName ??
                    translate('tasks.workspaceCreateDrawer.defaultBranch', 'Default branch')
                  }
                  navigates
                  onPress={() => {
                    setWorkspaceBaseBranchQuery(workspaceBaseBranch?.refName ?? '')
                    setShowWorkspaceBaseBranchPicker(true)
                  }}
                />
              </ListGroup>
            ) : null}
          </AutoHeight>

          {workspaceCreateTargetRepo ? null : (
            <Text style={styles.error}>
              {workspaceCreateDraft.item.provider === 'linear'
                ? translate(
                    'tasks.workspaceCreateDrawer.addRepository',
                    'Add a Git repository before creating a Linear workspace.'
                  )
                : translate(
                    'tasks.workspaceCreateDrawer.repositoryNotFound',
                    'Repository not found.'
                  )}
            </Text>
          )}

          <View style={styles.footer}>
            <SheetPrimaryButton
              label={
                workspaceAgentDetectionPending
                  ? translate('tasks.workspaceCreateDrawer.detectingAgents', 'Detecting agents...')
                  : workspaceCreateRequiresSshConnection
                    ? translate(
                        'tasks.workspaceCreateDrawer.connectRepository',
                        'Connect Repository'
                      )
                    : translate('tasks.workspaceCreateDrawer.title', 'Create Workspace')
              }
              busy={creating}
              disabled={
                !workspaceCreateTargetRepo ||
                workspaceCreateRequiresSshConnection ||
                workspaceAgentDetectionPending
              }
              onPress={() => {
                void createWorkspace(
                  workspaceCreateDraft.item,
                  workspaceCreateDraft.repoIdOverride,
                  undefined,
                  resolvedWorkspaceAgent,
                  workspaceNameDraft.trim(),
                  undefined,
                  workspaceBaseBranch?.refName,
                  workspaceBranchNameOverride &&
                    workspaceNameDraft.trim() === workspaceBranchAutoName
                    ? workspaceBranchNameOverride
                    : undefined,
                  undefined
                )
              }}
            />
          </View>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

export function renderMobileTasksWorkspaceCreateRepoPicker(model: ConnectionPresentationModel) {
  const {
    setShowWorkspaceCreateRepoPicker,
    setWorkspaceCreateDraft,
    showWorkspaceCreateRepoPicker,
    taskUiReady,
    workspaceCreateDraft,
    workspaceCreateTargetRepo,
    workspaceRepoOptions
  } = model
  return (
    <PickerModal
      visible={taskUiReady && workspaceCreateDraft != null && showWorkspaceCreateRepoPicker}
      title={translate('tasks.workspaceCreateDrawer.repository', 'Repository')}
      options={workspaceRepoOptions}
      selected={workspaceCreateTargetRepo?.id ?? ''}
      onSelect={(repoId) => {
        setWorkspaceCreateDraft((current) =>
          current ? { ...current, repoIdOverride: repoId } : current
        )
        setShowWorkspaceCreateRepoPicker(false)
      }}
      onClose={() => setShowWorkspaceCreateRepoPicker(false)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
    />
  )
}

export function renderMobileTasksWorkspaceAgentPicker(model: ConnectionPresentationModel) {
  const {
    resolvedWorkspaceAgent,
    setShowWorkspaceAgentPicker,
    setWorkspaceAgent,
    setWorkspaceAgentOverridden,
    showWorkspaceAgentPicker,
    taskUiReady,
    workspaceAgentOptions,
    workspaceCreateDraft
  } = model
  return (
    <PickerModal
      visible={taskUiReady && workspaceCreateDraft != null && showWorkspaceAgentPicker}
      title={translate('tasks.workspaceCreateDrawer.agent', 'Agent')}
      options={workspaceAgentOptions}
      selected={resolvedWorkspaceAgent}
      onSelect={(agent) => {
        setWorkspaceAgentOverridden(true)
        setWorkspaceAgent(agent)
        setShowWorkspaceAgentPicker(false)
      }}
      onClose={() => setShowWorkspaceAgentPicker(false)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
    />
  )
}
