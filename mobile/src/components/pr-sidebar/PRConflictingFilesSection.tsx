import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { Check, Copy, FileWarning, Sparkles } from 'lucide-react-native'
import { useClipboardWriter } from '../../platform/clipboard'
import { colors } from '../../theme/mobile-theme'
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
  let noticeBody = 'Conflict file details are unavailable'
  if (isRefreshing) {
    noticeBody = 'Refreshing conflict details…'
  } else if (conflict.localMergeClean) {
    noticeBody =
      'GitHub reports conflicts, but local Git did not reproduce them. Refresh the PR or push the branch to recalculate mergeability.'
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
      ? 'Copied'
      : copyState === 'failed'
        ? 'Failed to copy text'
        : 'Copy commands'

  return (
    <PRSection title="Conflicts">
      {conflict.commitsBehind !== null && conflict.baseCommit !== null ? (
        <Text style={styles.meta}>
          {conflict.commitsBehind} commit{conflict.commitsBehind === 1 ? '' : 's'} behind (base
          commit: <Text style={styles.metaMono}>{conflict.baseCommit}</Text>)
        </Text>
      ) : null}

      {conflict.fileDetailsUnavailable ? (
        <View>
          <Text style={styles.noticeTitle}>This branch has conflicts that must be resolved</Text>
          <Text style={styles.noticeBody}>{noticeBody}</Text>
          {conflict.mergeabilityRefreshCommands ? (
            <View style={styles.commandBox}>
              <View style={styles.commandHeader}>
                <Text style={styles.commandLabel}>Run from this worktree</Text>
                <Pressable
                  style={({ pressed }) => [
                    styles.copyCommandButton,
                    pressed && styles.copyCommandButtonPressed
                  ]}
                  onPress={() => void copyRefreshCommands()}
                  accessibilityRole="button"
                  accessibilityLabel="Copy mergeability refresh commands"
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
            <Text style={styles.filesHeaderText}>Conflicting files</Text>
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
            accessibilityLabel="Resolve conflicts with AI"
          >
            {triage.isBusy ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : (
              <Sparkles size={14} color={colors.textSecondary} strokeWidth={2.2} />
            )}
            <Text style={triageStyles.triageButtonText}>Resolve conflicts with AI</Text>
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
