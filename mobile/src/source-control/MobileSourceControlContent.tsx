import { ActivityIndicator, Pressable, SectionList, Text, TextInput, View } from 'react-native'
import { GitBranch, Minus, MoreHorizontal, Plus, Sparkles } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { MobileSourceControlReviewEntry } from './mobile-source-control-review-entry'
import { KEYBOARD_COMMIT_BAR_CLEARANCE } from './mobile-source-control-screen-state'
import { makeRenderFileRow, BranchCompareFooter } from './MobileSourceControlFileRows'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import { styles } from './mobile-source-control-styles'

type Props = {
  state: MobileSourceControlState
  hostId: string
  worktreeId: string
  name: string
}

// The ready-state body: summary card, changed-files list, and commit bar.
export function MobileSourceControlContent({ state, hostId, worktreeId, name }: Props) {
  const {
    connState,
    insets,
    screenState,
    busyAction,
    commitMessage,
    setCommitMessage,
    generatingMessage,
    setShowActionSheet,
    setDiscardTarget,
    actionError,
    keyboardLift,
    openingPath,
    openingBranchPath,
    status,
    sections,
    branchEntries,
    hasVisibleChanges,
    reviewableCount,
    stageablePaths,
    unstageablePaths,
    stagedCount,
    unstagedCount,
    branchLabel,
    syncLabel,
    stageAll,
    unstageAll,
    commit,
    generateCommitMessage,
    cancelGenerateCommitMessage,
    abortConflictOperation,
    openFile,
    openBranchDiff,
    runGitAction
  } = state
  const ioBusy = busyAction !== null || openingPath !== null || openingBranchPath !== null

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
        {actionError ? (
          <View style={styles.actionError}>
            <Text style={styles.actionErrorText} numberOfLines={2}>
              {actionError}
            </Text>
          </View>
        ) : null}
        <MobileSourceControlReviewEntry
          count={reviewableCount}
          disabled={screenState.kind !== 'ready' || connState !== 'connected' || ioBusy}
          hostId={hostId}
          worktreeId={worktreeId}
          worktreeName={name}
        />
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
              onSubmitEditing={() => void commit()}
            />
          )}
          <Pressable
            style={({ pressed }) => [
              styles.generateButton,
              (stagedCount === 0 || busyAction !== null) && styles.commitButtonDisabled,
              pressed && styles.commitButtonPressed
            ]}
            // Why: stay tappable while generating so the press can cancel
            // (disabling it here made the cancel branch below unreachable).
            disabled={stagedCount === 0 || busyAction !== null}
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
          <Pressable
            style={({ pressed }) => [
              styles.commitButton,
              (!commitMessage.trim() || stagedCount === 0 || ioBusy) && styles.commitButtonDisabled,
              pressed && styles.commitButtonPressed
            ]}
            onPress={() => void commit()}
            disabled={!commitMessage.trim() || stagedCount === 0 || ioBusy}
          >
            {busyAction === 'commit' ? (
              <ActivityIndicator size="small" color={colors.bgBase} />
            ) : (
              <Text style={styles.commitButtonText}>Commit</Text>
            )}
          </Pressable>
        </View>
      </View>
    </>
  )
}
