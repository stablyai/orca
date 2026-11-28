import { branchRefLabels, branchRefLabel } from '../../../../src/shared/git/refs/branch-ref-label'
import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { TextField } from '../../components/composer-input/TextField'
import { Search, Pencil } from 'lucide-react-native'
import { pressedStyle } from '../../theme/mobile-theme'
import { TASK_SECONDARY_DRAWER_Z_INDEX } from '../task-list/mobile-tasks-options'
import { ListGroup, ListRow } from '../../components/list/ListGroup'

export function renderMobileTasksWorkspaceBaseBranchPicker(model: ConnectionPresentationModel) {
  const {
    clearWorkspaceBaseBranch,
    colors,
    composerInputStyles,
    selectWorkspaceBaseBranch,
    setShowWorkspaceBaseBranchPicker,
    setWorkspaceBaseBranchQuery,
    showWorkspaceBaseBranchPicker,
    styles,
    t,
    taskUiReady,
    workspaceBaseBranch,
    workspaceBaseBranchError,
    workspaceBaseBranchLoading,
    workspaceBaseBranchQuery,
    workspaceBaseBranchResults,
    workspaceCreateDraft
  } = model
  const labels = branchRefLabels(workspaceBaseBranchResults.map((branch) => branch.refName))
  return (
    <BottomDrawer
      visible={taskUiReady && workspaceCreateDraft != null && showWorkspaceBaseBranchPicker}
      onClose={() => setShowWorkspaceBaseBranchPicker(false)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
    >
      <View>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>
            {t('tasks.workspaceOptionPickers.baseBranchTitle', 'Start From')}
          </Text>
          <Text style={styles.sheetSubtitle}>
            {t(
              'tasks.workspaceOptionPickers.baseBranchSubtitle',
              'Pick an existing branch or ref.'
            )}
          </Text>
        </View>
        <View style={styles.pickerStack}>
          <TextField
            value={workspaceBaseBranchQuery}
            onChangeText={setWorkspaceBaseBranchQuery}
            placeholder={t('tasks.workspaceOptionPickers.searchBranches', 'Search branches')}
            leading={<Search size={16} color={colors.textMuted} />}
            style={composerInputStyles.filledField}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <ListGroup>
            <ListRow
              key="default"
              title={t('tasks.workspaceOptionPickers.defaultBranch', 'Default branch')}
              subtitle={t(
                'tasks.workspaceOptionPickers.defaultBranchSubtitle',
                "Use this repository's configured base"
              )}
              selected={workspaceBaseBranch === null}
              onPress={() => {
                clearWorkspaceBaseBranch()
              }}
            />
            {workspaceBaseBranchResults.map((branch) => (
              <ListRow
                key={`${branch.refName}:${branch.localBranchName}`}
                title={labels.get(branch.refName) ?? branchRefLabel(branch.refName)}
                subtitle={
                  branch.localBranchName !== branchRefLabel(branch.refName)
                    ? t('tasks.workspaceOptionPickers.branchName', 'Branch name: {{name}}', {
                        name: branch.localBranchName
                      })
                    : undefined
                }
                selected={workspaceBaseBranch?.refName === branch.refName}
                onPress={() => {
                  selectWorkspaceBaseBranch(branch)
                }}
              />
            ))}
          </ListGroup>
          {workspaceBaseBranchLoading ? (
            <View style={styles.drawerLoadingRow}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
            </View>
          ) : workspaceBaseBranchError ? (
            <Text style={styles.detailError}>{workspaceBaseBranchError}</Text>
          ) : workspaceBaseBranchQuery.trim() && workspaceBaseBranchResults.length === 0 ? (
            <Text style={styles.detailMuted}>
              {t('tasks.workspaceOptionPickers.noBranches', 'No branches match.')}
            </Text>
          ) : null}
        </View>
      </View>
    </BottomDrawer>
  )
}

export function renderMobileTasksWorkspaceSparsePicker(model: ConnectionPresentationModel) {
  const {
    colors,
    setShowWorkspaceSparsePicker,
    setWorkspaceSparsePresetId,
    showWorkspaceSparsePicker,
    startEditWorkspaceSparsePreset,
    startNewWorkspaceSparsePreset,
    styles,
    t,
    taskUiReady,
    workspaceCreateDraft,
    workspaceSparsePresetId,
    workspaceSparsePresets,
    workspaceSparsePresetsLoaded,
    workspaceSparsePresetsLoading
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && workspaceCreateDraft != null && showWorkspaceSparsePicker}
      onClose={() => setShowWorkspaceSparsePicker(false)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
    >
      <View>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>
            {t('tasks.workspaceOptionPickers.sparseCheckoutTitle', 'Sparse Checkout')}
          </Text>
        </View>
        <ListGroup>
          <ListRow
            key="full"
            title={t('tasks.workspaceOptionPickers.fullCheckout', 'Full checkout')}
            subtitle={t(
              'tasks.workspaceOptionPickers.fullCheckoutSubtitle',
              'Use the whole repository'
            )}
            selected={workspaceSparsePresetId === null}
            onPress={() => {
              setWorkspaceSparsePresetId(null)
              setShowWorkspaceSparsePicker(false)
            }}
          />
          {workspaceSparsePresets.map((preset) => (
            <ListRow
              key={preset.id}
              title={preset.name}
              subtitle={preset.directories.join(', ')}
              selected={workspaceSparsePresetId === preset.id}
              accessory={
                <Pressable
                  style={({ pressed }) => [styles.iconActionButton, pressed && pressedStyle]}
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    'tasks.workspaceOptionPickers.editPreset',
                    'Edit {{name}}',
                    {
                      name: preset.name
                    }
                  )}
                  onPress={() => startEditWorkspaceSparsePreset(preset)}
                >
                  <Pencil size={15} color={colors.textMuted} />
                </Pressable>
              }
              onPress={() => {
                setWorkspaceSparsePresetId(preset.id)
                setShowWorkspaceSparsePicker(false)
              }}
            />
          ))}
        </ListGroup>
        <Pressable
          style={({ pressed }) => [
            styles.inlineSaveButton,
            !workspaceSparsePresetsLoaded || workspaceSparsePresetsLoading
              ? styles.fieldButtonDisabled
              : undefined,
            pressed && pressedStyle
          ]}
          disabled={!workspaceSparsePresetsLoaded || workspaceSparsePresetsLoading}
          onPress={startNewWorkspaceSparsePreset}
        >
          <Text style={styles.inlineSaveText}>
            {t('tasks.workspaceOptionPickers.newPreset', 'New preset')}
          </Text>
        </Pressable>
      </View>
    </BottomDrawer>
  )
}
