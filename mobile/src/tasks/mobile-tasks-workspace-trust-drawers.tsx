import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  Text,
  TextInput,
  colors,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  spacing,
  textStyles
} from './mobile-tasks-dependencies'
import { TASK_SECONDARY_DRAWER_Z_INDEX, setupSourceLabel } from './mobile-tasks-legacy-foundation'
import { styles } from './mobile-tasks-legacy-styles'
import { Button } from '../components/ui/Button'
import { PickerSheetTitle } from '../components/PickerModal'
import { sheetStyles } from './mobile-tasks-sheet-chrome'

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
                  setWorkspaceSparseDraft({
                    ...workspaceSparseDraft,
                    directoriesText
                  })
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

/** The script the prompt is about, in a quiet panel with its source above it. */
function SetupScriptPanel({ label, script }: { label: string; script: string }) {
  return (
    <View style={styles.setupPromptBox}>
      <Text style={styles.detailSectionTitle}>{label}</Text>
      <Text style={styles.setupPromptCommand} selectable>
        {script}
      </Text>
    </View>
  )
}

export function renderMobileTasksSetupTrustDrawer(model: ConnectionPresentationModel) {
  const { createWorkspace, creatingKey, setSetupPrompt, setupPrompt, taskUiReady } = model
  const create = (decision: 'run' | 'skip') => {
    if (!setupPrompt) {
      return
    }
    void createWorkspace(
      setupPrompt.item,
      setupPrompt.repoIdOverride,
      decision,
      setupPrompt.agentOverride,
      setupPrompt.workspaceNameOverride,
      setupPrompt.noteOverride,
      setupPrompt.baseBranchOverride,
      setupPrompt.branchNameOverride,
      setupPrompt.sparseCheckoutOverride
    )
  }
  const creating = setupPrompt != null && creatingKey === setupPrompt.item.key
  return (
    <BottomDrawer
      visible={taskUiReady && setupPrompt != null}
      onClose={() => setSetupPrompt(null)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
    >
      {setupPrompt ? (
        <View>
          <PickerSheetTitle
            title="Run the setup script?"
            subtitle={`${setupPrompt.repoName} asks before it creates a workspace.`}
          />
          <SetupScriptPanel
            label={setupSourceLabel(setupPrompt.source)}
            script={setupPrompt.command}
          />
          <View style={sheetStyles.actions}>
            <Button
              label="Run setup and create"
              variant="primary"
              block
              busy={creating}
              onPress={() => create('run')}
            />
            <Button
              label="Skip setup and create"
              variant="plain"
              block
              disabled={creating}
              onPress={() => create('skip')}
            />
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
  const trustAndRun = (always: boolean) => {
    if (!orcaYamlTrustPrompt) {
      return
    }
    void (async () => {
      try {
        await persistSetupHookTrust(
          orcaYamlTrustPrompt.repoId,
          orcaYamlTrustPrompt.contentHash,
          always
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
  const creating = orcaYamlTrustPrompt != null && creatingKey === orcaYamlTrustPrompt.item.key
  return (
    <BottomDrawer
      visible={taskUiReady && orcaYamlTrustPrompt != null}
      onClose={() => setOrcaYamlTrustPrompt(null)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
    >
      {orcaYamlTrustPrompt ? (
        <View>
          <PickerSheetTitle
            title={
              orcaYamlTrustPrompt.previouslyApproved
                ? `${orcaYamlTrustPrompt.repoName}'s setup script changed`
                : `Run setup from ${orcaYamlTrustPrompt.repoName}?`
            }
          />
          <Text style={trustStyles.message}>
            This repository's orca.yaml runs on your desktop before the workspace starts. Only run
            it if you trust this repository.
          </Text>
          <SetupScriptPanel
            label={orcaYamlTrustPrompt.previouslyApproved ? 'New setup script' : 'Setup script'}
            script={orcaYamlTrustPrompt.scriptContent}
          />
          <View style={sheetStyles.actions}>
            <Button
              label="Run once"
              variant="primary"
              block
              busy={creating}
              accessibilityLabel="Run hooks once"
              onPress={() => trustAndRun(false)}
            />
            <Button
              label="Always trust and run"
              block
              disabled={creating}
              onPress={() => trustAndRun(true)}
            />
            <Button
              label="Don't run"
              variant="plain"
              block
              disabled={creating}
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
            />
          </View>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

const trustStyles = StyleSheet.create({
  message: {
    ...textStyles.callout,
    color: colors.textSecondary,
    paddingHorizontal: spacing.lg - 4,
    marginBottom: spacing.lg
  }
})
