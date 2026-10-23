import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  Text,
  colors,
  Pressable,
  Check,
  Pencil,
  MobileSearchField,
  StyleSheet,
  spacing,
  triggerSelection
} from './mobile-tasks-dependencies'
import { TASK_SECONDARY_DRAWER_Z_INDEX } from './mobile-tasks-legacy-foundation'
import { styles } from './mobile-tasks-legacy-styles'
import { Banner } from '../components/ui/Banner'
import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { StateView } from '../components/ui/StateView'
import { PickerEmptyState } from '../components/PickerModal'
import { MobileTasksSheetHeader, sheetStyles } from './mobile-tasks-sheet-chrome'

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
        <MobileTasksSheetHeader
          title="Start from"
          subtitle="Pick a branch or ref."
          trailing={{
            label: 'Done',
            onPress: () => setShowWorkspaceBaseBranchPicker(false)
          }}
        />
        <View style={branchStyles.search}>
          <MobileSearchField
            value={workspaceBaseBranchQuery}
            onChangeText={setWorkspaceBaseBranchQuery}
            placeholder="Search branches"
          />
        </View>
        <ListGroup style={sheetStyles.group}>
          <ListRow
            key="default"
            title="Default branch"
            subtitle="This repository's configured base"
            selected={workspaceBaseBranch === null}
            onPress={() => {
              triggerSelection()
              clearWorkspaceBaseBranch()
            }}
          />
          {workspaceBaseBranchResults.map((branch) => (
            <ListRow
              key={`${branch.refName}:${branch.localBranchName}`}
              title={branch.refName}
              subtitle={
                branch.localBranchName !== branch.refName
                  ? `Branch name: ${branch.localBranchName}`
                  : undefined
              }
              selected={workspaceBaseBranch?.refName === branch.refName}
              onPress={() => {
                triggerSelection()
                selectWorkspaceBaseBranch(branch)
              }}
            />
          ))}
        </ListGroup>
        {workspaceBaseBranchLoading ? (
          <View style={sheetStyles.loading}>
            <StateView loading title="Searching branches…" />
          </View>
        ) : workspaceBaseBranchError ? (
          <View style={branchStyles.banner}>
            <Banner tone="error" message={workspaceBaseBranchError} />
          </View>
        ) : workspaceBaseBranchQuery.trim() && workspaceBaseBranchResults.length === 0 ? (
          <PickerEmptyState message="No branches match." />
        ) : null}
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
          <Text style={styles.sheetTitle}>Sparse Checkout</Text>
        </View>
        <View style={styles.detailGroup}>
          <Pressable
            style={styles.pickerRow}
            onPress={() => {
              setWorkspaceSparsePresetId(null)
              setShowWorkspaceSparsePicker(false)
            }}
          >
            <View style={styles.pickerCheck}>
              {workspaceSparsePresetId === null ? (
                <Check size={16} color={colors.textPrimary} />
              ) : null}
            </View>
            <View style={styles.pickerContent}>
              <Text style={styles.pickerLabel}>Full checkout</Text>
              <Text style={styles.pickerSubtitle}>Use the whole repository</Text>
            </View>
          </Pressable>
          {workspaceSparsePresets.map((preset) => (
            <View key={preset.id}>
              <View style={styles.groupSeparator} />
              <View style={styles.pickerRowWithAction}>
                <Pressable
                  style={styles.pickerRowMain}
                  onPress={() => {
                    setWorkspaceSparsePresetId(preset.id)
                    setShowWorkspaceSparsePicker(false)
                  }}
                >
                  <View style={styles.pickerCheck}>
                    {workspaceSparsePresetId === preset.id ? (
                      <Check size={16} color={colors.textPrimary} />
                    ) : null}
                  </View>
                  <View style={styles.pickerContent}>
                    <Text style={styles.pickerLabel} numberOfLines={1}>
                      {preset.name}
                    </Text>
                    <Text style={styles.pickerSubtitle} numberOfLines={2}>
                      {preset.directories.join(', ')}
                    </Text>
                  </View>
                </Pressable>
                <Pressable
                  style={styles.iconActionButton}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${preset.name}`}
                  onPress={() => startEditWorkspaceSparsePreset(preset)}
                >
                  <Pencil size={15} color={colors.textMuted} />
                </Pressable>
              </View>
            </View>
          ))}
        </View>
        <Pressable
          style={[
            styles.inlineSaveButton,
            !workspaceSparsePresetsLoaded || workspaceSparsePresetsLoading
              ? styles.fieldButtonDisabled
              : undefined
          ]}
          disabled={!workspaceSparsePresetsLoaded || workspaceSparsePresetsLoading}
          onPress={startNewWorkspaceSparsePreset}
        >
          <Text style={styles.inlineSaveText}>New preset</Text>
        </Pressable>
      </View>
    </BottomDrawer>
  )
}

const branchStyles = StyleSheet.create({
  search: { paddingHorizontal: spacing.xs, marginBottom: spacing.md },
  banner: { marginHorizontal: -spacing.sm, marginTop: spacing.md }
})
