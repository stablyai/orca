import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Animated, Easing, Text, View } from 'react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { SHEET_CURVE } from '../components/sheet-motion-values'
import { MobileSourceControlChangesHeader } from './MobileSourceControlChangesHeader'
import { MobileCommitFailurePanel } from './MobileCommitFailurePanel'
import { MobileSourceControlFileList } from './MobileSourceControlFileList'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import { styles } from './mobile-source-control-styles'
import { hubStyles } from './mobile-source-control-hub-styles'

const CLEAN_FADE_MS = 240
const REDUCED_CLEAN_FADE_MS = 150

// The clean state settles in when a commit empties the list; on load it is simply there.
function CleanStateFade({ animate, children }: { animate: boolean; children: ReactNode }) {
  const reducedMotion = useReducedMotionEnabled() === true
  const shown = useRef(new Animated.Value(animate ? 0 : 1)).current
  useEffect(() => {
    if (!animate) {
      return
    }
    Animated.timing(shown, {
      toValue: 1,
      duration: reducedMotion ? REDUCED_CLEAN_FADE_MS : CLEAN_FADE_MS,
      easing: Easing.bezier(...SHEET_CURVE),
      useNativeDriver: true
    }).start()
  }, [animate, reducedMotion, shown])
  const scale = reducedMotion
    ? 1
    : shown.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] })
  return (
    <Animated.View style={[styles.state, { opacity: shown, transform: [{ scale }] }]}>
      {children}
    </Animated.View>
  )
}

type Props = {
  state: Omit<MobileSourceControlState, 'primaryActionArgs'>
  /** Clears the next-step bar the panel floats over the list. */
  bottomInset: number
  onOpenCommits: () => void
}

export function MobileSourceControlContent({ state, bottomInset, onOpenCommits }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { busyAction, hasVisibleChanges } = state
  // Commit runners keep busyAction set ('commit…') until the refreshed status has landed.
  const [listShown, setListShown] = useState(hasVisibleChanges)
  const [cleanedByCommit, setCleanedByCommit] = useState(false)
  if (listShown !== hasVisibleChanges) {
    setListShown(hasVisibleChanges)
    setCleanedByCommit(!hasVisibleChanges && busyAction?.startsWith('commit') === true)
  }
  // Pick only what the list reads, so commit-message keystrokes never re-render its rows.
  const {
    connState,
    status,
    branchLabel,
    branchCompareResult,
    actionError,
    commitFailureRecovery,
    commitFailureRecoveryAction,
    openBranchPicker,
    abortConflictOperation,
    sections,
    shouldShowBranchCompareSection,
    branchEntries,
    branchCompareState,
    stageablePaths,
    unstageablePaths,
    stageAll,
    unstageAll,
    openDiffForFile,
    resolveConflict,
    runGitAction,
    setDiscardTarget
  } = state
  const header = useMemo(
    () => (
      <MobileSourceControlChangesHeader
        state={{
          status,
          branchLabel,
          branchCompareResult,
          busyAction,
          openBranchPicker,
          abortConflictOperation
        }}
        onOpenCommits={onOpenCommits}
      />
    ),
    [
      abortConflictOperation,
      branchCompareResult,
      branchLabel,
      busyAction,
      onOpenCommits,
      openBranchPicker,
      status
    ]
  )
  const list = useMemo(
    () => (
      <MobileSourceControlFileList
        state={{
          sections,
          status,
          shouldShowBranchCompareSection,
          branchEntries,
          branchCompareState,
          branchCompareResult,
          stageablePaths,
          unstageablePaths,
          stageAll,
          unstageAll,
          busyAction,
          openDiffForFile,
          resolveConflict,
          runGitAction,
          setDiscardTarget
        }}
        header={header}
        bottomInset={bottomInset + spacing.lg}
      />
    ),
    [
      bottomInset,
      branchCompareResult,
      branchCompareState,
      branchEntries,
      busyAction,
      header,
      openDiffForFile,
      resolveConflict,
      runGitAction,
      sections,
      setDiscardTarget,
      shouldShowBranchCompareSection,
      stageAll,
      stageablePaths,
      status,
      unstageAll,
      unstageablePaths
    ]
  )
  // Outside the list, so a failure stays in view however far the rows are scrolled.
  const feedback =
    connState !== 'connected' || commitFailureRecovery || actionError ? (
      <View style={hubStyles.changesControls}>
        {connState !== 'connected' ? (
          // Retained rows look actionable offline; show reconnect state beside them.
          <View style={styles.reconnectBanner}>
            <ActivityIndicator size="small" color={colors.statusAmber} />
            <Text style={styles.reconnectBannerText}>
              {t('sourceControl.content.reconnecting', 'Reconnecting to desktop...')}
            </Text>
          </View>
        ) : null}
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
      </View>
    ) : null
  if (!hasVisibleChanges) {
    return (
      <View style={hubStyles.tabBody}>
        {feedback}
        <View style={hubStyles.changesControls}>{header}</View>
        <CleanStateFade animate={cleanedByCommit}>
          <Text style={styles.stateTitle}>
            {t('sourceControl.content.emptyTitle', 'No local changes')}
          </Text>
          <Text style={styles.stateText}>
            {t('sourceControl.content.emptyMessage', 'Working tree is clean.')}
          </Text>
        </CleanStateFade>
      </View>
    )
  }
  return (
    <View style={hubStyles.tabBody}>
      {feedback}
      {list}
    </View>
  )
}
