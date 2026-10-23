import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  Text,
  StyleSheet,
  colors,
  workspaceSshStatusLabel,
  MobileWorkspaceNameInput,
  MobileAgentIcon,
  workspaceAgentLabel,
  PickerModal
} from './mobile-tasks-dependencies'
import { Button } from '../components/ui/Button'
import { Collapsible } from '../components/ui/Collapsible'
import { ListGroup, LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import {
  MobileTasksSheetError,
  MobileTasksSheetHeader,
  sheetStyles
} from './mobile-tasks-sheet-chrome'
import {
  TASK_SECONDARY_DRAWER_Z_INDEX,
  getRepoBadgeColor,
  workspaceAgentIconId
} from './mobile-tasks-legacy-foundation'
import { styles } from './mobile-tasks-legacy-styles'

export function renderMobileTasksWorkspaceCreateDrawer(model: ConnectionPresentationModel) {
  const {
    connectWorkspaceSshRepo,
    createWorkspace,
    creatingKey,
    error,
    setError,
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
    workspaceCreateSshConnectInProgress,
    workspaceCreateSshError,
    workspaceCreateSshStatus,
    workspaceCreateTargetConnectionId,
    workspaceCreateTargetRepo,
    workspaceNameDraft
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && workspaceCreateDraft != null}
      onClose={() => setWorkspaceCreateDraft(null)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
    >
      {workspaceCreateDraft ? (
        <View>
          <MobileTasksSheetHeader
            title="New workspace"
            subtitle={workspaceCreateDraft.item.title}
            leading={{
              label: 'Cancel',
              onPress: () => setWorkspaceCreateDraft(null)
            }}
          />
          <MobileTasksSheetError error={error} onDismiss={() => setError('')} />

          <View style={sheetStyles.form}>
            <ListGroup separatorInset={LIST_LEADING_INSET} style={workspaceStyles.flushGroup}>
              <ListRow
                key="repo"
                title="Repository"
                value={workspaceCreateTargetRepo?.displayName ?? 'Choose'}
                leading={
                  <View
                    style={[
                      sheetStyles.dot,
                      workspaceCreateTargetRepo
                        ? {
                            backgroundColor: getRepoBadgeColor(
                              workspaceCreateTargetRepo,
                              workspaceCreateTargetRepo.displayName
                            )
                          }
                        : { backgroundColor: colors.textMuted }
                    ]}
                  />
                }
                navigates={workspaceCreateCanPickRepo}
                onPress={
                  workspaceCreateCanPickRepo
                    ? () => setShowWorkspaceCreateRepoPicker(true)
                    : undefined
                }
              />
              <ListRow
                key="agent"
                title="Agent"
                value={
                  workspaceCreateRequiresSshConnection
                    ? 'Connect first'
                    : workspaceAgentDetectionPending
                      ? 'Detecting…'
                      : workspaceAgentLabel(resolvedWorkspaceAgent)
                }
                leading={
                  <MobileAgentIcon
                    agentId={workspaceAgentIconId(resolvedWorkspaceAgent)}
                    size={18}
                  />
                }
                navigates
                disabled={workspaceCreateRequiresSshConnection}
                onPress={() => setShowWorkspaceAgentPicker(true)}
              />
            </ListGroup>

            {workspaceCreateTargetConnectionId ? (
              <View>
                <Text style={styles.workspaceCreateLabel}>SSH connection</Text>
                <View style={styles.sshConnectCard}>
                  <View style={styles.sshStatusRow}>
                    <View
                      style={[
                        styles.sshStatusDot,
                        workspaceCreateSshStatus === 'connected'
                          ? styles.sshStatusDotConnected
                          : workspaceCreateSshConnectInProgress
                            ? styles.sshStatusDotProgress
                            : styles.sshStatusDotDisconnected
                      ]}
                    />
                    <View style={styles.sshStatusCopy}>
                      <Text style={styles.sshStatusTitle} numberOfLines={1}>
                        {workspaceCreateTargetRepo?.displayName ?? 'Remote repository'}
                      </Text>
                      <Text style={styles.detailMuted}>
                        {workspaceSshStatusLabel(workspaceCreateSshStatus)}
                      </Text>
                    </View>
                    {workspaceCreateSshStatus === 'connected' ? null : (
                      <Button
                        label="Connect"
                        size="compact"
                        busy={workspaceCreateSshConnectInProgress}
                        onPress={() => void connectWorkspaceSshRepo()}
                      />
                    )}
                  </View>
                  {workspaceCreateSshError ? (
                    <Text style={styles.detailError}>{workspaceCreateSshError}</Text>
                  ) : null}
                </View>
              </View>
            ) : null}

            <View>
              <Text style={styles.workspaceCreateLabel}>
                Workspace name <Text style={styles.workspaceCreateLabelHint}>(optional)</Text>
              </Text>
              <MobileWorkspaceNameInput
                style={styles.input}
                value={workspaceNameDraft}
                onChangeText={handleWorkspaceNameDraftChange}
                placeholderTextColor={colors.textMuted}
                selectionColor={colors.accentBlue}
                accessibilityLabel="Workspace name"
                shouldAutoFocus={taskUiReady && workspaceCreateDraft !== null}
              />
            </View>

            <View>
              <SectionHeader
                title="Advanced"
                expanded={showWorkspaceAdvanced}
                onToggle={() => setShowWorkspaceAdvanced((current) => !current)}
                first
              />
              <Collapsible open={showWorkspaceAdvanced}>
                <ListGroup style={workspaceStyles.flushGroup}>
                  <ListRow
                    title="Start from"
                    subtitle={
                      workspaceBaseBranch
                        ? `Creates from ${workspaceBaseBranch.refName}`
                        : undefined
                    }
                    value={workspaceBaseBranch?.refName ?? 'Default branch'}
                    navigates
                    onPress={() => {
                      setWorkspaceBaseBranchQuery(workspaceBaseBranch?.refName ?? '')
                      setShowWorkspaceBaseBranchPicker(true)
                    }}
                  />
                </ListGroup>
              </Collapsible>
            </View>

            {workspaceCreateTargetRepo ? null : (
              <Text style={styles.detailError}>
                {workspaceCreateDraft.item.provider === 'linear'
                  ? 'Add a Git repository to Orca before starting a Linear workspace.'
                  : "This repository isn't in Orca on your desktop."}
              </Text>
            )}
          </View>

          <View style={sheetStyles.actions}>
            <Button
              label={
                workspaceAgentDetectionPending
                  ? 'Detecting agents…'
                  : workspaceCreateRequiresSshConnection
                    ? 'Connect repository first'
                    : 'Create workspace'
              }
              variant="primary"
              block
              busy={creatingKey === workspaceCreateDraft.item.key}
              disabled={
                !workspaceCreateTargetRepo ||
                workspaceCreateRequiresSshConnection ||
                workspaceAgentDetectionPending
              }
              testID="mobile-tasks-create-workspace"
              onPress={() => {
                // Why: this compact issue-to-workspace flow should match the
                // basic create workspace path; sparse checkout can return later.
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
      title="Repository"
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
      title="Agent"
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

const workspaceStyles = StyleSheet.create({
  // The form already insets 4; groups sit on its edge.
  flushGroup: { marginHorizontal: 0 }
})
