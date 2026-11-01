import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { Check, Copy, FileWarning, Sparkles } from 'lucide-react-native'
import { useClipboardWriter } from '../../platform/clipboard'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import { PRSection } from './PRSection'
import { resolveConflictDisplay } from './pr-conflict-presentation'
import { prConflictStyles as styles } from './pr-conflict-styles'
import { prAiTriageStyles as triageStyles } from './pr-ai-triage-styles'
import { AgentLaunchNotice } from '../AgentLaunchNotice'
import type { MobileAgentLaunchAvailability } from '../../session/mobile-agent-launch-availability'

// Launches the "Resolve conflicts with AI" agent. Absent for display-only usages.
export type PrConflictsTriage = {
  resolveConflicts: () => void
  isBusy: boolean
  availability: MobileAgentLaunchAvailability
  success: string | null
  error: string | null
  warning: string | null
  undeliveredPrompt: string | null
}

type Props = {
  // Accept conflict view-model inputs only; full PRInfo remains compatible.
  pr: Pick<PRInfo, 'mergeable' | 'conflictSummary'>
  // Explain absent file details as loading while refresh is in flight, matching desktop.
  isRefreshing?: boolean
  triage?: PrConflictsTriage
}

// Show hosted conflicts as paths or missing-list fallback, matching desktop conflict/notice components.
export function PRConflictingFilesSection({ pr, isRefreshing = false, triage }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Use clipboard seam: iOS custom scheme lacks page secure context, while Android https provides one.
  const clipboard = useClipboardWriter()
  // Track idle/success/failure: dropping pasteboard refusal used to look like successful copy, unlike Tasks error reporting.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copiedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conflict = resolveConflictDisplay(pr)

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current) {
        clearTimeout(copiedResetTimerRef.current)
      }
    }
  }, [])

  if (!conflict) {
    return null
  }
  let noticeBody = t(
    'pullRequest.conflictingFilesSection.detailsUnavailable',
    'Conflict file details are unavailable'
  )
  if (isRefreshing) {
    noticeBody = t('pullRequest.conflictingFilesSection.refreshing', 'Refreshing conflict details…')
  } else if (conflict.localMergeClean) {
    noticeBody = t(
      'pullRequest.conflictingFilesSection.localMergeClean',
      'GitHub reports conflicts, but local Git did not reproduce them. Refresh the PR or push the branch to recalculate mergeability.'
    )
  }

  const copyRefreshCommands = async () => {
    if (!conflict.mergeabilityRefreshCommands) {
      return
    }
    let next: 'copied' | 'failed' = 'copied'
    try {
      await clipboard.writeText(conflict.mergeabilityRefreshCommands)
    } catch {
      next = 'failed'
    }
    if (copiedResetTimerRef.current) {
      clearTimeout(copiedResetTimerRef.current)
    }
    setCopyState(next)
    copiedResetTimerRef.current = setTimeout(() => {
      copiedResetTimerRef.current = null
      setCopyState('idle')
    }, 1500)
  }

  const copyLabel =
    copyState === 'copied'
      ? t('common.copied', 'Copied')
      : copyState === 'failed'
        ? t('pullRequest.conflictingFilesSection.copyFailed', 'Failed to copy text')
        : t('pullRequest.conflictingFilesSection.copyCommands', 'Copy commands')
  const count = conflict.commitsBehind
  // Preserve the commit's styling when a translation moves its placeholder.
  const behindParts =
    count !== null && conflict.baseCommit !== null
      ? (count === 1
          ? t(
              'pullRequest.conflictingFilesSection.commitsBehind_one',
              '{{count}} commit behind (base commit: {{baseCommit}})',
              { count, baseCommit: '\uFFFC' }
            )
          : t(
              'pullRequest.conflictingFilesSection.commitsBehind_other',
              '{{count}} commits behind (base commit: {{baseCommit}})',
              { count, baseCommit: '\uFFFC' }
            )
        ).split('\uFFFC')
      : null

  return (
    <PRSection title={t('pullRequest.conflictingFilesSection.title', 'Conflicts')}>
      {behindParts ? (
        <Text style={styles.meta}>
          {behindParts[0]}
          <Text style={styles.metaMono}>{conflict.baseCommit}</Text>
          {behindParts.slice(1).join('')}
        </Text>
      ) : null}

      {conflict.fileDetailsUnavailable ? (
        <View>
          <Text style={styles.noticeTitle}>
            {t(
              'pullRequest.conflictingFilesSection.mustResolve',
              'This branch has conflicts that must be resolved'
            )}
          </Text>
          <Text style={styles.noticeBody}>{noticeBody}</Text>
          {conflict.mergeabilityRefreshCommands ? (
            <View style={styles.commandBox}>
              <View style={styles.commandHeader}>
                <Text style={styles.commandLabel}>
                  {t(
                    'pullRequest.conflictingFilesSection.runFromWorktree',
                    'Run from this worktree'
                  )}
                </Text>
                <Pressable
                  style={({ pressed }) => [
                    styles.copyCommandButton,
                    pressed && styles.copyCommandButtonPressed
                  ]}
                  onPress={() => void copyRefreshCommands()}
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    'pullRequest.conflictingFilesSection.copyRefreshCommands',
                    'Copy mergeability refresh commands'
                  )}
                >
                  {copyState === 'copied' ? (
                    <Check size={13} color={colors.textPrimary} strokeWidth={2.2} />
                  ) : (
                    <Copy size={13} color={colors.textPrimary} strokeWidth={2.2} />
                  )}
                  <Text style={styles.copyCommandText}>{copyLabel}</Text>
                </Pressable>
              </View>
              <Text selectable style={styles.commandText}>
                {conflict.mergeabilityRefreshCommands}
              </Text>
            </View>
          ) : null}
        </View>
      ) : (
        <View>
          <View style={styles.filesHeader}>
            <FileWarning size={14} color={colors.textSecondary} strokeWidth={2} />
            <Text style={styles.filesHeaderText}>
              {t('pullRequest.conflictingFilesSection.filesHeading', 'Conflicting files')}
            </Text>
          </View>
          <ScrollView
            style={styles.fileList}
            contentContainerStyle={styles.fileListContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
          >
            {conflict.files.map((filePath) => (
              <View key={filePath} style={styles.fileRow}>
                <Text style={styles.filePath}>{filePath}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Launch desktop-style conflict agent to bring base branch in and complete merge. */}
      {triage ? (
        <View style={triageStyles.triageArea}>
          <Pressable
            style={({ pressed }) => [
              triageStyles.triageButton,
              pressed && triageStyles.triageButtonPressed
            ]}
            onPress={triage.resolveConflicts}
            disabled={triage.isBusy || triage.availability !== 'available'}
            accessibilityRole="button"
            accessibilityLabel={t(
              'pullRequest.conflictingFilesSection.resolveWithAi',
              'Resolve conflicts with AI'
            )}
          >
            {triage.isBusy ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : (
              <Sparkles size={14} color={colors.textSecondary} strokeWidth={2.2} />
            )}
            <Text style={triageStyles.triageButtonText}>
              {t('pullRequest.conflictingFilesSection.resolveWithAi', 'Resolve conflicts with AI')}
            </Text>
          </Pressable>
          <AgentLaunchNotice
            availability={triage.availability}
            success={triage.success}
            error={triage.error}
            warning={triage.warning}
            undeliveredPrompt={triage.undeliveredPrompt}
            errorStyle={triageStyles.triageError}
          />
        </View>
      ) : null}
    </PRSection>
  )
}
