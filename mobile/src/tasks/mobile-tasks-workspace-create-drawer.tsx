import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  Text,
  Pressable,
  ChevronDown,
  colors,
  workspaceSshStatusLabel,
  MobileWorkspaceNameInput,
  MobileAgentIcon,
  workspaceAgentLabel,
  ChevronUp,
  GitBranch,
  ActivityIndicator,
  PickerModal
} from './mobile-tasks-dependencies'
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
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Create Workspace</Text>
            <Text style={styles.sheetSubtitle} numberOfLines={2}>
              {workspaceCreateDraft.item.title}
            </Text>
          </View>

          <View style={styles.workspaceCreateForm}>
            <View style={styles.workspaceCreateField}>
              <Text style={styles.workspaceCreateLabel}>Repository</Text>
              <Pressable
                style={styles.fieldButton}
                disabled={!workspaceCreateCanPickRepo}
                onPress={() => setShowWorkspaceCreateRepoPicker(true)}
              >
                {workspaceCreateTargetRepo ? (
                  <View
                    style={[
                      styles.pickerRepoDot,
                      {
                        backgroundColor: getRepoBadgeColor(
                          workspaceCreateTargetRepo,
                          workspaceCreateTargetRepo.displayName
                        )
                      }
                    ]}
                  />
                ) : null}
                <Text
                  style={[
                    styles.fieldButtonText,
                    !workspaceCreateTargetRepo ? styles.fieldButtonPlaceholder : undefined
                  ]}
                  numberOfLines={1}
                >
                  {workspaceCreateTargetRepo?.displayName ?? 'Select a repository'}
                </Text>
                {workspaceCreateCanPickRepo ? (
                  <ChevronDown size={14} color={colors.textMuted} />
                ) : null}
              </Pressable>
            </View>

            {workspaceCreateTargetConnectionId ? (
              <View style={styles.workspaceCreateField}>
                <Text style={styles.workspaceCreateLabel}>SSH Connection</Text>
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
                      <Pressable
                        style={[
                          styles.inlineSaveButtonCompact,
                          workspaceCreateSshConnectInProgress
                            ? styles.fieldButtonDisabled
                            : undefined
                        ]}
                        disabled={workspaceCreateSshConnectInProgress}
                        onPress={() => void connectWorkspaceSshRepo()}
                      >
                        <Text style={styles.inlineSaveText}>
                          {workspaceCreateSshConnectInProgress ? 'Connecting...' : 'Connect'}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                  {workspaceCreateSshError ? (
                    <Text style={styles.detailError}>{workspaceCreateSshError}</Text>
                  ) : null}
                </View>
              </View>
            ) : null}

            <View style={styles.workspaceCreateField}>
              <Text style={styles.workspaceCreateLabel}>
                Workspace Name <Text style={styles.workspaceCreateLabelHint}>[Optional]</Text>
              </Text>
              <MobileWorkspaceNameInput
                style={styles.input}
                value={workspaceNameDraft}
                onChangeText={handleWorkspaceNameDraftChange}
                placeholderTextColor={colors.textMuted}
                shouldAutoFocus={taskUiReady && workspaceCreateDraft !== null}
              />
            </View>

            <View style={styles.workspaceCreateField}>
              <Text style={styles.workspaceCreateLabel}>Agent</Text>
              <Pressable
                style={[
                  styles.fieldButton,
                  workspaceCreateRequiresSshConnection ? styles.fieldButtonDisabled : undefined
                ]}
                disabled={workspaceCreateRequiresSshConnection}
                onPress={() => setShowWorkspaceAgentPicker(true)}
              >
                <MobileAgentIcon agentId={workspaceAgentIconId(resolvedWorkspaceAgent)} size={16} />
                <Text style={styles.fieldButtonText} numberOfLines={1}>
                  {workspaceCreateRequiresSshConnection
                    ? 'Connect repository first'
                    : workspaceAgentDetectionPending
                      ? 'Detecting agents...'
                      : workspaceAgentLabel(resolvedWorkspaceAgent)}
                </Text>
                <ChevronDown size={14} color={colors.textMuted} />
              </Pressable>
            </View>

            <Pressable
              style={styles.workspaceAdvancedToggle}
              onPress={() => setShowWorkspaceAdvanced((current) => !current)}
            >
              <Text style={styles.workspaceAdvancedText}>Advanced</Text>
              {showWorkspaceAdvanced ? (
                <ChevronUp size={14} color={colors.textSecondary} />
              ) : (
                <ChevronDown size={14} color={colors.textSecondary} />
              )}
            </Pressable>

            {showWorkspaceAdvanced ? (
              <View style={styles.workspaceCreateField}>
                <Text style={styles.workspaceCreateLabel}>Start from</Text>
                <Pressable
                  style={styles.fieldButton}
                  onPress={() => {
                    setWorkspaceBaseBranchQuery(workspaceBaseBranch?.refName ?? '')
                    setShowWorkspaceBaseBranchPicker(true)
                  }}
                >
                  <GitBranch size={14} color={colors.textMuted} />
                  <Text style={styles.fieldButtonText} numberOfLines={1}>
                    {workspaceBaseBranch?.refName ?? 'Default branch'}
                  </Text>
                  <ChevronDown size={14} color={colors.textMuted} />
                </Pressable>
                {workspaceBaseBranch ? (
                  <Text style={styles.detailMuted} numberOfLines={1}>
                    Create from {workspaceBaseBranch.refName}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>

          {workspaceCreateTargetRepo ? null : (
            <Text style={styles.detailError}>
              {workspaceCreateDraft.item.provider === 'linear'
                ? 'Add a Git repository before creating a Linear workspace.'
                : 'Repository not found.'}
            </Text>
          )}

          <View style={styles.workspaceCreateActions}>
            <Pressable
              style={[
                styles.createButton,
                styles.workspaceCreateButton,
                (!workspaceCreateTargetRepo ||
                  workspaceCreateRequiresSshConnection ||
                  workspaceAgentDetectionPending ||
                  creatingKey === workspaceCreateDraft.item.key) &&
                  styles.createButtonDisabled
              ]}
              disabled={
                !workspaceCreateTargetRepo ||
                workspaceCreateRequiresSshConnection ||
                workspaceAgentDetectionPending ||
                creatingKey === workspaceCreateDraft.item.key
              }
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
            >
              {creatingKey === workspaceCreateDraft.item.key ? (
                <ActivityIndicator size="small" color={colors.bgBase} />
              ) : (
                <Text style={styles.createButtonText}>
                  {workspaceAgentDetectionPending
                    ? 'Detecting agents...'
                    : workspaceCreateRequiresSshConnection
                      ? 'Connect Repository'
                      : 'Create Workspace'}
                </Text>
              )}
            </Pressable>
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
