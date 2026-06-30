import { ActivityIndicator, Pressable, SectionList, Text, TextInput, View } from 'react-native'
import { GitBranch, Minus, MoreHorizontal, Plus, Sparkles } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { MobileSourceControlCreatePrEntry } from './MobileSourceControlCreatePrEntry'
import { MobileCommitFailurePanel } from './MobileCommitFailurePanel'
import { KEYBOARD_COMMIT_BAR_CLEARANCE } from './mobile-source-control-screen-state'
import { makeRenderFileRow, BranchCompareFooter } from './MobileSourceControlFileRows'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import { styles } from './mobile-source-control-styles'

type Props = {
  state: MobileSourceControlState
}

// The ready-state body: summary card, changed-files list, and commit bar.
export function MobileSourceControlContent({ state }: Props) {
  const {
    insets,
    busyAction,
    commitMessage,
    setCommitMessage,
    generatingMessage,
    setShowActionSheet,
    setDiscardTarget,
    actionError,
    commitFailureRecovery,
    commitFailureRecoveryAction,
    keyboardLift,
    openingPath,
    openingBranchPath,
    status,
    sections,
    branchEntries,
    hasVisibleChanges,
    stageablePaths,
    unstageablePaths,
    stagedCount,
    unstagedCount,
    branchLabel,
    syncLabel,
    primaryAction,
    createPrAction,
    stageAll,
    unstageAll,
    generateCommitMessage,
    cancelGenerateCommitMessage,
    abortConflictOperation,
    openFile,
    openBranchDiff,
    runGitAction
  } = state
  const ioBusy = busyAction !== null || openingPath !== null || openingBranchPath !== null
  const shouldShowGenerateButton = stagedCount > 0 || generatingMessage
  const createPrHeroActive =
    createPrAction.visible && !createPrAction.disabled && !createPrAction.pushFirst

  return (
    <>
      <View style={styles.summaryCard}>
        <View style={styles.summaryHeader}>
          <View style={styles.branchLine}>
            <GitBranch size={15} color={colors.textSecondary} strokeWidth={2.1} />
            <Text style={styles.branchText} numberOfLines={1}>
              {branchLabel}
            </Text>
          </View>
          {syncLabel ? <Text style={styles.syncText}>{syncLabel}</Text> : null}
        </View>
        <View style={styles.countRow}>
          <Text style={styles.countText}>{unstagedCount} changed</Text>
          <Text style={styles.countText}>{stagedCount} staged</Text>
          {branchEntries.length > 0 ? (
            <Text style={styles.countText}>{branchEntries.length} on branch</Text>
          ) : null}
          {status && status.conflictOperation !== 'unknown' ? (
            <View style={styles.conflictRow}>
              <Text style={styles.conflictText}>{status.conflictOperation}</Text>
              {(status.conflictOperation === 'merge' || status.conflictOperation === 'rebase') && (
                <Pressable
                  style={({ pressed }) => [styles.abortButton, pressed && styles.abortPressed]}
                  disabled={busyAction !== null}
                  onPress={() => void abortConflictOperation(status.conflictOperation)}
                >
                  <Text style={styles.abortText}>
                    {busyAction === `abort-${status.conflictOperation}`
                      ? 'Aborting…'
                      : `Abort ${status.conflictOperation}`}
                  </Text>
                </Pressable>
              )}
            </View>
          ) : null}
        </View>
        {commitFailureRecovery ? (
          <MobileCommitFailurePanel
            failure={commitFailureRecovery}
            action={commitFailureRecoveryAction}
          />
        ) : actionError ? (
          <View style={styles.actionError}>
            <Text style={styles.actionErrorText} numberOfLines={2}>
              {actionError}
            </Text>
          </View>
        ) : null}
        <MobileSourceControlCreatePrEntry action={createPrAction} />
        <View style={styles.bulkRow}>
          <Pressable
            style={({ pressed }) => [
              styles.bulkButton,
              (stageablePaths.length === 0 || ioBusy) && styles.bulkButtonDisabled,
              pressed && styles.bulkButtonPressed
            ]}
            onPress={() => void stageAll()}
            disabled={ioBusy || stageablePaths.length === 0}
          >
            {busyAction === 'stage-all' ? (
              <ActivityIndicator size="small" color={colors.textPrimary} />
            ) : (
              <Plus size={15} color={colors.textPrimary} strokeWidth={2.2} />
            )}
            <Text style={styles.bulkButtonText}>Stage All</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.bulkButton,
              (unstageablePaths.length === 0 || ioBusy) && styles.bulkButtonDisabled,
              pressed && styles.bulkButtonPressed
            ]}
            onPress={() => void unstageAll()}
            disabled={ioBusy || unstageablePaths.length === 0}
          >
            {busyAction === 'unstage-all' ? (
              <ActivityIndicator size="small" color={colors.textPrimary} />
            ) : (
              <Minus size={15} color={colors.textPrimary} strokeWidth={2.2} />
            )}
            <Text style={styles.bulkButtonText}>Unstage All</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.bulkMenuButton,
              pressed && styles.bulkButtonPressed,
              ioBusy && styles.bulkButtonDisabled
            ]}
            onPress={() => setShowActionSheet(true)}
            disabled={ioBusy}
            hitSlop={8}
            accessibilityLabel="Open source control actions"
          >
            <MoreHorizontal size={18} color={colors.textPrimary} strokeWidth={2.1} />
          </Pressable>
        </View>
      </View>

      {!hasVisibleChanges ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>No Changes</Text>
          <Text style={styles.stateText}>Working tree is clean.</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          renderItem={makeRenderFileRow({
            busyAction,
            openingPath,
            openingBranchPath,
            openFile,
            runGitAction,
            setDiscardTarget
          })}
          keyExtractor={(item) => `${item.area}:${item.path}:${item.oldPath ?? ''}`}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.sectionCount}>{section.data.length}</Text>
            </View>
          )}
          ListFooterComponent={
            <BranchCompareFooter
              state={{
                shouldShowBranchCompareSection: state.shouldShowBranchCompareSection,
                branchCompareSummaryText: state.branchCompareSummaryText,
                branchEntries: state.branchEntries,
                branchCompareState: state.branchCompareState,
                branchCompareResult: state.branchCompareResult,
                busyAction,
                openBranchDiff,
                openingBranchPath,
                openingPath
              }}
            />
          }
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.listContent}
        />
      )}

      <View
        style={[
          styles.commitBar,
          {
            bottom: keyboardLift > 0 ? keyboardLift + KEYBOARD_COMMIT_BAR_CLEARANCE : keyboardLift,
            paddingBottom: keyboardLift > 0 ? spacing.md : spacing.md + insets.bottom
          }
        ]}
      >
        <View style={styles.commitRow}>
          {stagedCount === 0 ? (
            <View
              style={[styles.commitInput, styles.commitInputDisabled]}
              accessibilityRole="text"
              accessibilityState={{ disabled: true }}
              accessibilityLabel="Commit message disabled. No staged files."
            >
              <Text style={styles.commitInputDisabledText}>No staged files</Text>
            </View>
          ) : (
            <TextInput
              style={styles.commitInput}
              value={commitMessage}
              onChangeText={setCommitMessage}
              placeholder="Commit message"
              placeholderTextColor={colors.textMuted}
              editable={busyAction === null && openingPath === null && openingBranchPath === null}
              returnKeyType="done"
              onSubmitEditing={primaryAction.onPress}
            />
          )}
          {shouldShowGenerateButton ? (
            <Pressable
              style={({ pressed }) => [
                styles.generateButton,
                busyAction !== null && styles.commitButtonDisabled,
                pressed && styles.commitButtonPressed
              ]}
              // Why: commit-message AI belongs to the commit path; hiding it
              // during Stage All keeps the quick action visually unambiguous.
              disabled={busyAction !== null}
              onPress={() =>
                generatingMessage ? cancelGenerateCommitMessage() : void generateCommitMessage()
              }
              accessibilityLabel={
                generatingMessage
                  ? 'Cancel commit message generation'
                  : 'Generate commit message with AI'
              }
            >
              {generatingMessage ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : (
                <Sparkles size={16} color={colors.textSecondary} strokeWidth={2.1} />
              )}
            </Pressable>
          ) : null}
          <Pressable
            style={({ pressed }) => [
              styles.commitButton,
              createPrHeroActive && styles.commitButtonSecondary,
              primaryAction.disabled && styles.commitButtonDisabled,
              pressed && styles.commitButtonPressed
            ]}
            onPress={primaryAction.onPress}
            disabled={primaryAction.disabled}
            accessibilityLabel={primaryAction.accessibilityLabel}
            accessibilityHint={primaryAction.accessibilityHint}
          >
            {primaryAction.loading ? (
              <ActivityIndicator
                size="small"
                color={createPrHeroActive ? colors.textPrimary : colors.bgBase}
              />
            ) : (
              <Text
                style={[
                  styles.commitButtonText,
                  createPrHeroActive && styles.commitButtonSecondaryText
                ]}
              >
                {primaryAction.label}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </>
  )
}
