import { branchRefLabel } from '../../../../src/shared/git/refs/branch-ref-label'
import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { View, Text } from 'react-native'
import { MobileWorkspaceNameInput } from '../../components/rename/MobileWorkspaceNameInput'
import { MobileAgentIcon } from '../../components/icons/MobileAgentIcon'
import { workspaceAgentLabel } from '../../new-workspace/creation/workspace-agent-selection'
import { PickerModal } from '../../components/sheets/PickerModal'
import { AutoHeight } from '../../components/motion/AutoHeight'
import {
  LIST_LEADING_INSET,
  ListGroup,
  SectionHeader,
  ListRow
} from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { TASK_SECONDARY_DRAWER_Z_INDEX } from '../task-list/mobile-tasks-options'
import { getRepoBadgeColor } from '../repositories/mobile-tasks-repository-presentation'
import { workspaceAgentIconId } from '../mobile-tasks-project-workspace-types'
import { newWorktreeFormStylesSheet } from '../../new-workspace/creation/forms/new-worktree-form-styles'
import { NewWorkspaceSshConnectionField } from '../../new-workspace/creation/forms/NewWorkspaceSshConnectionField'
import type { MobileColorScheme } from '../../theme/mobile-theme'

export function renderMobileTasksWorkspaceCreateDrawer(
  model: ConnectionPresentationModel,
  colorScheme: MobileColorScheme
) {
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
    t,
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
  const styles = newWorktreeFormStylesSheet.resolve(colorScheme)
  const closeDrawer = () => setWorkspaceCreateDraft(null)
  const repositoryTitle = t('tasks.workspaceCreateDrawer.repository', 'Repository')
  const agentTitle = t('tasks.workspaceCreateDrawer.agent', 'Agent')
  const repositoryValue =
    workspaceCreateTargetRepo?.displayName ??
    t('tasks.workspaceCreateDrawer.selectRepository', 'Select a repository')
  const agentValue = workspaceCreateRequiresSshConnection
    ? t('tasks.workspaceCreateDrawer.connectFirst', 'Connect repository first')
    : workspaceAgentDetectionPending
      ? t('tasks.workspaceCreateDrawer.detectingAgents', 'Detecting agents...')
      : workspaceAgentLabel(t, resolvedWorkspaceAgent)
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
              title={t('tasks.workspaceCreateDrawer.createWorkspace', 'Create workspace')}
              subtitle={workspaceCreateDraft.item.title}
              leading={{ label: t('common.cancel', 'Cancel'), onPress: closeDrawer }}
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
                t('tasks.workspaceCreateDrawer.remoteRepository', 'Remote repository')
              }
              sshGate={workspaceCreateSshGate}
              onConnect={() => void connectWorkspaceSshRepo()}
            />
          ) : null}

          <SectionHeader title={t('tasks.workspaceCreateDrawer.nameSection', 'Workspace name')} />
          <MobileWorkspaceNameInput
            value={workspaceNameDraft}
            onChangeText={handleWorkspaceNameDraftChange}
            shouldAutoFocus={taskUiReady && workspaceCreateDraft !== null}
          />

          <SectionHeader
            title={t('tasks.workspaceCreateDrawer.advanced', 'Advanced')}
            expanded={showWorkspaceAdvanced}
            onToggle={() => setShowWorkspaceAdvanced((current) => !current)}
          />
          <AutoHeight>
            {showWorkspaceAdvanced ? (
              <ListGroup>
                <ListRow
                  key="startFrom"
                  title={t('tasks.workspaceCreateDrawer.startFrom', 'Start from')}
                  value={
                    (workspaceBaseBranch ? branchRefLabel(workspaceBaseBranch.refName) : null) ??
                    t('tasks.workspaceCreateDrawer.defaultBranch', 'Default branch')
                  }
                  navigates
                  onPress={() => {
                    setWorkspaceBaseBranchQuery(
                      workspaceBaseBranch ? branchRefLabel(workspaceBaseBranch.refName) : ''
                    )
                    setShowWorkspaceBaseBranchPicker(true)
                  }}
                />
              </ListGroup>
            ) : null}
          </AutoHeight>

          {workspaceCreateTargetRepo ? null : (
            <Text style={styles.error}>
              {workspaceCreateDraft.item.provider === 'linear'
                ? t(
                    'tasks.workspaceCreateDrawer.addRepository',
                    'Add a Git repository before creating a Linear workspace.'
                  )
                : t('tasks.workspaceCreateDrawer.repositoryNotFound', 'Repository not found.')}
            </Text>
          )}

          <View style={styles.footer}>
            <SheetPrimaryButton
              label={
                workspaceAgentDetectionPending
                  ? t('tasks.workspaceCreateDrawer.detectingAgents', 'Detecting agents...')
                  : workspaceCreateRequiresSshConnection
                    ? t('tasks.workspaceCreateDrawer.connectRepositoryAction', 'Connect repository')
                    : t('tasks.workspaceCreateDrawer.createWorkspace', 'Create workspace')
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
    t,
    taskUiReady,
    workspaceCreateDraft,
    workspaceCreateTargetRepo,
    workspaceRepoOptions
  } = model
  return (
    <PickerModal
      visible={taskUiReady && workspaceCreateDraft != null && showWorkspaceCreateRepoPicker}
      title={t('tasks.workspaceCreateDrawer.repository', 'Repository')}
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
    t,
    taskUiReady,
    workspaceAgentOptions,
    workspaceCreateDraft
  } = model
  return (
    <PickerModal
      visible={taskUiReady && workspaceCreateDraft != null && showWorkspaceAgentPicker}
      title={t('tasks.workspaceCreateDrawer.agent', 'Agent')}
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
