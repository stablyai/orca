import { useEffect, useRef, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { Check, Copy, FileWarning, Sparkles } from 'lucide-react-native'
import { useClipboardWriter } from '../../platform/clipboard'
import { triggerError, triggerSuccess } from '../../platform/haptics'
import { colors } from '../../theme/mobile-theme'
import { Button } from '../ui/Button'
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
  // What it reads, not the whole PR: the conflict view-model is the only thing derived here, and
  // a caller holding a full `PRInfo` satisfies this.
  pr: Pick<PRInfo, 'mergeable' | 'conflictSummary'>
  // True while a refresh is in flight, so the fallback notice can explain that
  // missing conflict file details may still be loading (desktop parity).
  isRefreshing?: boolean
  triage?: PrConflictsTriage
}

// Conflicting-files section — shown only when the hosted review reports merge
// conflicts. Lists the conflicting file paths, or a fallback notice when the file
// list is not yet available. Ports the desktop ConflictingFilesSection +
// MergeConflictNotice into the mobile card shell.
export function PRConflictingFilesSection({ pr, isRefreshing = false, triage }: Props) {
  // The seam, not `expo-clipboard`: inside the shell the page's own clipboard needs a secure
  // context, which the iOS custom scheme is not and Android's https is.
  const clipboard = useClipboardWriter()
  // Three states, not a boolean: a refused write used to be caught and dropped, so the tap was
  // indistinguishable from one that copied. The tasks page reports its refusals the same way.
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
    if (next === 'copied') {
      triggerSuccess()
    } else {
      triggerError()
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
    <PRSection
      title="Conflicts"
      footer={
        // "Resolve conflicts with AI" mirrors desktop's PRTriageStrip: an agent brings the base in and completes the merge.
        triage ? (
          <View style={triageStyles.triageArea}>
            <Button
              label="Resolve conflicts with AI"
              icon={Sparkles}
              size="compact"
              busy={triage.isBusy}
              disabled={triage.availability !== 'available'}
              onPress={triage.resolveConflicts}
            />
            <AgentLaunchNotice
              availability={triage.availability}
              success={triage.success}
              error={triage.error}
              warning={triage.warning}
              undeliveredPrompt={triage.undeliveredPrompt}
              errorStyle={triageStyles.triageError}
            />
          </View>
        ) : undefined
      }
    >
      {conflict.fileDetailsUnavailable ? (
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>This branch has conflicts that must be resolved.</Text>
          <Text style={styles.noticeBody}>{noticeBody}</Text>
        </View>
      ) : (
        <View style={styles.filesHeader}>
          <FileWarning size={18} color={colors.statusAmber} strokeWidth={2} />
          <Text style={styles.noticeTitle}>
            {conflict.files.length} conflicting file{conflict.files.length === 1 ? '' : 's'}
          </Text>
        </View>
      )}

      {conflict.commitsBehind !== null && conflict.baseCommit !== null ? (
        <Text style={styles.meta}>
          {conflict.commitsBehind} commit{conflict.commitsBehind === 1 ? '' : 's'} behind (base
          commit <Text style={styles.metaMono}>{conflict.baseCommit}</Text>)
        </Text>
      ) : null}

      {conflict.fileDetailsUnavailable ? (
        conflict.mergeabilityRefreshCommands ? (
          <View style={styles.commandBlock}>
            <View style={styles.commandHeader}>
              <Text style={styles.commandLabel}>Run from this worktree</Text>
              <Button
                label={copyLabel}
                icon={copyState === 'copied' ? Check : Copy}
                variant="plain"
                size="compact"
                onPress={() => void copyRefreshCommands()}
                accessibilityLabel="Copy mergeability refresh commands"
              />
            </View>
            <View style={styles.commandBox}>
              <Text selectable style={styles.commandText}>
                {conflict.mergeabilityRefreshCommands}
              </Text>
            </View>
          </View>
        ) : null
      ) : (
        <ScrollView
          style={styles.fileList}
          contentContainerStyle={styles.fileListContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
        >
          {conflict.files.map((filePath) => {
            const slash = filePath.lastIndexOf('/')
            return (
              <View key={filePath} style={styles.fileRow}>
                <Text style={styles.fileName} numberOfLines={1}>
                  {slash === -1 ? filePath : filePath.slice(slash + 1)}
                </Text>
                {slash > 0 ? (
                  <Text style={styles.fileDir} numberOfLines={1} ellipsizeMode="head">
                    {filePath.slice(0, slash)}
                  </Text>
                ) : null}
              </View>
            )
          })}
        </ScrollView>
      )}
    </PRSection>
  )
}
