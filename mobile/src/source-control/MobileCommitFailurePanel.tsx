import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { AlertCircle, ChevronDown, ChevronRight, Sparkles } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { AgentLaunchNotice } from '../components/AgentLaunchNotice'
import { Button } from '../components/ui/Button'
import { Collapsible } from '../components/ui/Collapsible'
import type { MobileCommitFailureRecovery } from './mobile-commit-failure-recovery'
import type { MobileCommitFailureRecoveryAction } from './use-mobile-commit-failure-recovery'
import { styles } from './mobile-source-control-styles'

type Props = {
  failure: MobileCommitFailureRecovery
  action: MobileCommitFailureRecoveryAction
}

export function MobileCommitFailurePanel({ failure, action }: Props) {
  const [expanded, setExpanded] = useState(false)
  const detailsText = failure.error.trim()

  return (
    <View style={styles.commitFailurePanel} accessibilityRole="alert">
      <View style={styles.commitFailureHeader}>
        <AlertCircle size={18} color={colors.danger} strokeWidth={2.2} />
        <View style={styles.commitFailureTextBlock}>
          <Text style={styles.commitFailureTitle}>Commit failed</Text>
          <Text style={styles.commitFailureSummary} numberOfLines={3}>
            {action.summary ?? 'The commit did not go through.'}
          </Text>
        </View>
      </View>
      <View style={styles.commitFailureActions}>
        <Button
          label="Fix with AI"
          icon={Sparkles}
          size="compact"
          variant="secondary"
          busy={action.launching}
          disabled={action.availability !== 'available'}
          onPress={() => void action.launch()}
          accessibilityLabel="Fix commit failure with AI"
        />
        {action.hasDetails && detailsText ? (
          <Button
            label={expanded ? 'Hide details' : 'Show details'}
            icon={expanded ? ChevronDown : ChevronRight}
            size="compact"
            variant="plain"
            onPress={() => setExpanded((current) => !current)}
            accessibilityLabel={
              expanded ? 'Hide commit failure details' : 'Show commit failure details'
            }
          />
        ) : null}
      </View>
      {/* Cancels the panel's gap while shut and carries it inside, so it eases in with the text. */}
      <View style={localStyles.detailsFrame}>
        <Collapsible open={expanded && detailsText.length > 0}>
          <Text style={[styles.commitFailureDetailsText, localStyles.detailsGap]} selectable>
            {detailsText}
          </Text>
        </Collapsible>
      </View>
      <AgentLaunchNotice
        availability={action.availability}
        success={action.launchSuccess}
        error={action.launchError}
        warning={action.launchWarning}
        undeliveredPrompt={action.undeliveredPrompt}
        errorStyle={styles.commitFailureLaunchError}
      />
    </View>
  )
}

const localStyles = StyleSheet.create({
  detailsFrame: { marginTop: -spacing.sm },
  detailsGap: { paddingTop: spacing.sm }
})
