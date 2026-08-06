import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Check, Copy, FileWarning, Sparkles } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { PRInfo } from '../../../../src/shared/types'
import { PRSection } from './PRSection'
import { resolveConflictDisplay } from './pr-conflict-presentation'
import { prConflictStyles as styles } from './pr-conflict-styles'
import { prAiTriageStyles as triageStyles } from './pr-ai-triage-styles'
import { t } from '@/i18n/mobile-i18n'

// Launches the "Resolve conflicts with AI" agent. Absent for display-only usages.
export type PrConflictsTriage = {
  resolveConflicts: () => void
  isBusy: boolean
  error: string | null
}

type Props = {
  pr: PRInfo
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
  const [commandsCopied, setCommandsCopied] = useState(false)
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
  let noticeBody = t('pullRequest.conflicts.fileDetailsUnavailable')
  if (isRefreshing) {
    noticeBody = t('pullRequest.conflicts.refreshing')
  } else if (conflict.localMergeClean) {
    noticeBody = t('pullRequest.conflicts.localMergeClean')
  }

  const copyRefreshCommands = async () => {
    if (!conflict.mergeabilityRefreshCommands) {
      return
    }
    try {
      await Clipboard.setStringAsync(conflict.mergeabilityRefreshCommands)
    } catch {
      return
    }
    if (copiedResetTimerRef.current) {
      clearTimeout(copiedResetTimerRef.current)
    }
    setCommandsCopied(true)
    copiedResetTimerRef.current = setTimeout(() => {
      copiedResetTimerRef.current = null
      setCommandsCopied(false)
    }, 1500)
  }

  return (
    <PRSection title={t('prconflictingFilesSection.conflicts')}>
      {conflict.commitsBehind !== null && conflict.baseCommit !== null ? (
        <Text style={styles.meta}>
          {t(
            conflict.commitsBehind === 1
              ? 'prconflictingFilesSection.commitsBehindCommit'
              : 'prconflictingFilesSection.commitsBehindCommits',
            {
              commitsBehind: conflict.commitsBehind
            }
          )}{' '}
          <Text style={styles.metaMono}>{conflict.baseCommit}</Text>)
        </Text>
      ) : null}

      {conflict.fileDetailsUnavailable ? (
        <View>
          <Text style={styles.noticeTitle}>{t('prconflictingFilesSection.branch')}</Text>
          <Text style={styles.noticeBody}>{noticeBody}</Text>
          {conflict.mergeabilityRefreshCommands ? (
            <View style={styles.commandBox}>
              <View style={styles.commandHeader}>
                <Text style={styles.commandLabel}>{t('prconflictingFilesSection.run')}</Text>
                <Pressable
                  style={({ pressed }) => [
                    styles.copyCommandButton,
                    pressed && styles.copyCommandButtonPressed
                  ]}
                  onPress={() => void copyRefreshCommands()}
                  accessibilityRole="button"
                  accessibilityLabel={t('prconflictingFilesSection.copyMergeability')}
                >
                  {commandsCopied ? (
                    <Check size={13} color={colors.textPrimary} strokeWidth={2.2} />
                  ) : (
                    <Copy size={13} color={colors.textPrimary} strokeWidth={2.2} />
                  )}
                  <Text style={styles.copyCommandText}>
                    {commandsCopied
                      ? t('prconflictingFilesSection.copied')
                      : t('prconflictingFilesSection.copyCommands')}
                  </Text>
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
            <Text style={styles.filesHeaderText}>{t('prconflictingFilesSection.conflicting')}</Text>
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

      {/* "Resolve conflicts with AI" — mirrors desktop's PRTriageStrip. Launches an
          agent that brings the base branch in and completes the merge. */}
      {triage ? (
        <View style={triageStyles.triageArea}>
          <Pressable
            style={({ pressed }) => [
              triageStyles.triageButton,
              pressed && triageStyles.triageButtonPressed
            ]}
            onPress={triage.resolveConflicts}
            disabled={triage.isBusy}
            accessibilityRole="button"
            accessibilityLabel={t('prconflictingFilesSection.resolve')}
          >
            {triage.isBusy ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : (
              <Sparkles size={14} color={colors.textSecondary} strokeWidth={2.2} />
            )}
            <Text style={triageStyles.triageButtonText}>
              {t('prconflictingFilesSection.resolve')}
            </Text>
          </Pressable>
          {triage.error ? <Text style={triageStyles.triageError}>{triage.error}</Text> : null}
        </View>
      ) : null}
    </PRSection>
  )
}
