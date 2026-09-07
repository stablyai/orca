import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  Text,
  TextInput,
  colors,
  Pressable,
  ActivityIndicator,
  Check,
  X
} from './mobile-tasks-dependencies'
import { TASK_SECONDARY_DRAWER_Z_INDEX, setupSourceLabel } from './mobile-tasks-legacy-foundation'
import { styles } from './mobile-tasks-legacy-styles'

export function renderMobileTasksWorkspaceSparseDrawer(model: ConnectionPresentationModel) {
  const {
    canSaveWorkspaceSparseDraft,
    saveWorkspaceSparsePreset,
    setWorkspaceSparseDraft,
    taskUiReady,
    workspaceCreateDraft,
    workspaceSparseDraft,
    workspaceSparseDraftError,
    workspaceSparseDraftParsed,
    workspaceSparseSaving
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && workspaceCreateDraft != null && workspaceSparseDraft != null}
      onClose={() => {
        if (!workspaceSparseSaving) {
          setWorkspaceSparseDraft(null)
        }
      }}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 2}
    >
      {workspaceSparseDraft ? (
        <View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>
              {workspaceSparseDraft.mode === 'new' ? 'New Sparse Preset' : 'Edit Sparse Preset'}
            </Text>
          </View>
          <View style={styles.detailGroup}>
            <View style={styles.detailSection}>
              <Text style={styles.detailSectionTitle}>Name</Text>
              <TextInput
                style={styles.input}
                value={workspaceSparseDraft.name}
                onChangeText={(name) => setWorkspaceSparseDraft({ ...workspaceSparseDraft, name })}
                placeholder="Renderer UI"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={80}
              />
            </View>
            <View style={styles.detailSection}>
              <Text style={styles.detailSectionTitle}>Directories</Text>
              <TextInput
                style={[styles.input, styles.bodyInput, styles.monoInput]}
                value={workspaceSparseDraft.directoriesText}
                onChangeText={(directoriesText) =>
                  setWorkspaceSparseDraft({ ...workspaceSparseDraft, directoriesText })
                }
                placeholder={'src/renderer\npackages/ui'}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                textAlignVertical="top"
              />
            </View>
            <Text style={workspaceSparseDraftError ? styles.detailError : styles.detailMuted}>
              {workspaceSparseDraftError ??
                (workspaceSparseDraftParsed?.directories.length === 1
                  ? '1 directory'
                  : `${workspaceSparseDraftParsed?.directories.length ?? 0} directories`)}
            </Text>
          </View>
          <View style={styles.drawerActionRow}>
            <Pressable
              style={styles.secondaryActionButton}
              disabled={workspaceSparseSaving}
              onPress={() => setWorkspaceSparseDraft(null)}
            >
              <Text style={styles.secondaryActionText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[
                styles.primaryActionButton,
                !canSaveWorkspaceSparseDraft ? styles.fieldButtonDisabled : undefined
              ]}
              disabled={!canSaveWorkspaceSparseDraft}
              onPress={() => void saveWorkspaceSparsePreset()}
            >
              {workspaceSparseSaving ? (
                <ActivityIndicator size="small" color={colors.bgBase} />
              ) : null}
              <Text style={styles.primaryActionText}>Save</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

export function renderMobileTasksSetupTrustDrawer(model: ConnectionPresentationModel) {
  const { createWorkspace, creatingKey, setSetupPrompt, setupPrompt, taskUiReady } = model
  return (
    <BottomDrawer
      visible={taskUiReady && setupPrompt != null}
      onClose={() => setSetupPrompt(null)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
    >
      {setupPrompt ? (
        <View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Run Setup Script?</Text>
            <Text style={styles.sheetSubtitle}>
              {setupPrompt.repoName} requires a setup choice before creating this workspace.
            </Text>
          </View>

          <View style={styles.setupPromptBox}>
            <View style={styles.detailSectionHeader}>
              <Text style={styles.detailSectionTitle}>{setupSourceLabel(setupPrompt.source)}</Text>
            </View>
            <Text style={styles.setupPromptCommand}>{setupPrompt.command}</Text>
          </View>

          <View style={styles.actionGroup}>
            <Pressable
              style={styles.actionRow}
              disabled={creatingKey === setupPrompt.item.key}
              onPress={() =>
                void createWorkspace(
                  setupPrompt.item,
                  setupPrompt.repoIdOverride,
                  'run',
                  setupPrompt.agentOverride,
                  setupPrompt.workspaceNameOverride,
                  setupPrompt.noteOverride,
                  setupPrompt.baseBranchOverride,
                  setupPrompt.branchNameOverride,
                  setupPrompt.sparseCheckoutOverride
                )
              }
            >
              <Check size={16} color={colors.textPrimary} />
              <Text style={styles.actionText}>
                {creatingKey === setupPrompt.item.key ? 'Creating...' : 'Run setup and create'}
              </Text>
            </Pressable>
            <View style={styles.actionSeparator} />
            <Pressable
              style={styles.actionRow}
              disabled={creatingKey === setupPrompt.item.key}
              onPress={() =>
                void createWorkspace(
                  setupPrompt.item,
                  setupPrompt.repoIdOverride,
                  'skip',
                  setupPrompt.agentOverride,
                  setupPrompt.workspaceNameOverride,
                  setupPrompt.noteOverride,
                  setupPrompt.baseBranchOverride,
                  setupPrompt.branchNameOverride,
                  setupPrompt.sparseCheckoutOverride
                )
              }
            >
              <X size={16} color={colors.textPrimary} />
              <Text style={styles.actionText}>Skip setup and create</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

export function renderMobileTasksOrcaYamlTrustDrawer(model: ConnectionPresentationModel) {
  const {
    createWorkspace,
    creatingKey,
    orcaYamlTrustPrompt,
    persistSetupHookTrust,
    setError,
    setOrcaYamlTrustPrompt,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && orcaYamlTrustPrompt != null}
      onClose={() => setOrcaYamlTrustPrompt(null)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
    >
      {orcaYamlTrustPrompt ? (
        <View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>
              {orcaYamlTrustPrompt.previouslyApproved
                ? `${orcaYamlTrustPrompt.repoName}'s setup script changed`
                : `Run setup from ${orcaYamlTrustPrompt.repoName}?`}
            </Text>
            <Text style={styles.sheetSubtitle}>
              This repository's orca.yaml runs on your machine before the workspace starts. Only run
              it if you trust this repository.
            </Text>
          </View>

          <View style={styles.setupPromptBox}>
            <View style={styles.detailSectionHeader}>
              <Text style={styles.detailSectionTitle}>
                {orcaYamlTrustPrompt.previouslyApproved ? 'New setup script' : 'Setup script'}
              </Text>
            </View>
            <Text style={styles.setupPromptCommand}>{orcaYamlTrustPrompt.scriptContent}</Text>
          </View>

          <View style={styles.actionGroup}>
            <Pressable
              style={styles.actionRow}
              disabled={creatingKey === orcaYamlTrustPrompt.item.key}
              onPress={() =>
                void (async () => {
                  try {
                    await persistSetupHookTrust(
                      orcaYamlTrustPrompt.repoId,
                      orcaYamlTrustPrompt.contentHash,
                      false
                    )
                    setOrcaYamlTrustPrompt(null)
                    await createWorkspace(
                      orcaYamlTrustPrompt.item,
                      orcaYamlTrustPrompt.repoIdOverride,
                      'run',
                      orcaYamlTrustPrompt.agentOverride,
                      orcaYamlTrustPrompt.workspaceNameOverride,
                      orcaYamlTrustPrompt.noteOverride,
                      orcaYamlTrustPrompt.baseBranchOverride,
                      orcaYamlTrustPrompt.branchNameOverride,
                      orcaYamlTrustPrompt.sparseCheckoutOverride,
                      orcaYamlTrustPrompt.contentHash
                    )
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to trust setup script.')
                  }
                })()
              }
            >
              <Check size={16} color={colors.textPrimary} />
              <Text style={styles.actionText}>Run hooks</Text>
            </Pressable>
            <View style={styles.actionSeparator} />
            <Pressable
              style={styles.actionRow}
              disabled={creatingKey === orcaYamlTrustPrompt.item.key}
              onPress={() =>
                void (async () => {
                  try {
                    await persistSetupHookTrust(
                      orcaYamlTrustPrompt.repoId,
                      orcaYamlTrustPrompt.contentHash,
                      true
                    )
                    setOrcaYamlTrustPrompt(null)
                    await createWorkspace(
                      orcaYamlTrustPrompt.item,
                      orcaYamlTrustPrompt.repoIdOverride,
                      'run',
                      orcaYamlTrustPrompt.agentOverride,
                      orcaYamlTrustPrompt.workspaceNameOverride,
                      orcaYamlTrustPrompt.noteOverride,
                      orcaYamlTrustPrompt.baseBranchOverride,
                      orcaYamlTrustPrompt.branchNameOverride,
                      orcaYamlTrustPrompt.sparseCheckoutOverride,
                      orcaYamlTrustPrompt.contentHash
                    )
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to trust setup script.')
                  }
                })()
              }
            >
              <Check size={16} color={colors.textPrimary} />
              <Text style={styles.actionText}>Always trust and run</Text>
            </Pressable>
            <View style={styles.actionSeparator} />
            <Pressable
              style={styles.actionRow}
              disabled={creatingKey === orcaYamlTrustPrompt.item.key}
              onPress={() => {
                const prompt = orcaYamlTrustPrompt
                setOrcaYamlTrustPrompt(null)
                void createWorkspace(
                  prompt.item,
                  prompt.repoIdOverride,
                  'skip',
                  prompt.agentOverride,
                  prompt.workspaceNameOverride,
                  prompt.noteOverride,
                  prompt.baseBranchOverride,
                  prompt.branchNameOverride,
                  prompt.sparseCheckoutOverride
                )
              }}
            >
              <X size={16} color={colors.textPrimary} />
              <Text style={styles.actionText}>Don't run</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </BottomDrawer>
  )
}
