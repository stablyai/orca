import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Sparkles } from 'lucide-react-native'
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
  // What it reads, not the whole PR: a caller holding a full `PRInfo` satisfies this.
  pr: Pick<PRInfo, 'mergeable' | 'baseRefName'>
  triage?: PrConflictsTriage
}

// Conflicts section — shown only when the hosted review reports merge conflicts.
// Ports the desktop MergeConflictNotice into the mobile card shell.
export function PRMergeConflictsSection({ pr, triage }: Props) {
  const conflict = resolveConflictDisplay(pr)
  if (!conflict) {
    return null
  }

  return (
    <PRSection title="Conflicts">
      <View>
        <Text style={styles.noticeTitle}>{conflict.title}</Text>
        <Text style={styles.noticeBody}>{conflict.body}</Text>
      </View>

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
