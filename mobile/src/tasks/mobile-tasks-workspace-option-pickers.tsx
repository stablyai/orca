import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  Text,
  TextField,
  Search,
  colors,
  Pressable,
  ActivityIndicator,
  Pencil
} from './mobile-tasks-dependencies'
import { TASK_SECONDARY_DRAWER_Z_INDEX } from './mobile-tasks-legacy-foundation'
import { ListGroup, ListRow } from '../components/list/ListGroup'
import { styles } from './mobile-tasks-legacy-styles'
import { translate } from '../i18n/mobile-i18n'
import { pressedStyle } from '../theme/mobile-theme'

export function renderMobileTasksWorkspaceBaseBranchPicker(model: ConnectionPresentationModel) {
  const {
    clearWorkspaceBaseBranch,
    selectWorkspaceBaseBranch,
    setShowWorkspaceBaseBranchPicker,
    setWorkspaceBaseBranchQuery,
    showWorkspaceBaseBranchPicker,
    taskUiReady,
    workspaceBaseBranch,
    workspaceBaseBranchError,
    workspaceBaseBranchLoading,
    workspaceBaseBranchQuery,
    workspaceBaseBranchResults,
    workspaceCreateDraft
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && workspaceCreateDraft != null && showWorkspaceBaseBranchPicker}
      onClose={() => setShowWorkspaceBaseBranchPicker(false)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
    >
      <View>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>
            {translate('tasks.workspaceOptionPickers.baseBranchTitle', 'Start From')}
          </Text>
          <Text style={styles.sheetSubtitle}>
            {translate(
              'tasks.workspaceOptionPickers.baseBranchSubtitle',
              'Pick an existing branch or ref.'
            )}
          </Text>
        </View>
        <View style={styles.pickerStack}>
          <TextField
            value={workspaceBaseBranchQuery}
            onChangeText={setWorkspaceBaseBranchQuery}
            placeholder={translate(
              'tasks.workspaceOptionPickers.searchBranches',
              'Search branches'
            )}
            leading={<Search size={16} color={colors.textMuted} />}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <ListGroup>
            <ListRow
              key="default"
              title={translate('tasks.workspaceOptionPickers.defaultBranch', 'Default branch')}
              subtitle={translate(
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
                title={branch.refName}
                subtitle={
                  branch.localBranchName !== branch.refName
                    ? translate(
                        'tasks.workspaceOptionPickers.branchName',
                        'Branch name: {{name}}',
                        {
                          name: branch.localBranchName
                        }
                      )
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
              {translate('tasks.workspaceOptionPickers.noBranches', 'No branches match.')}
            </Text>
          ) : null}
        </View>
      </View>
    </BottomDrawer>
  )
}

export function renderMobileTasksWorkspaceSparsePicker(model: ConnectionPresentationModel) {
  const {
    setShowWorkspaceSparsePicker,
    setWorkspaceSparsePresetId,
    showWorkspaceSparsePicker,
    startEditWorkspaceSparsePreset,
    startNewWorkspaceSparsePreset,
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
            {translate('tasks.workspaceOptionPickers.sparseCheckoutTitle', 'Sparse Checkout')}
          </Text>
        </View>
        <ListGroup>
          <ListRow
            key="full"
            title={translate('tasks.workspaceOptionPickers.fullCheckout', 'Full checkout')}
            subtitle={translate(
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
                  accessibilityLabel={translate(
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
            {translate('tasks.workspaceOptionPickers.newPreset', 'New preset')}
          </Text>
        </Pressable>
      </View>
    </BottomDrawer>
  )
}
