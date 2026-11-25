import { useState } from 'react'
import { Text, View } from 'react-native'
import { Sparkles } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { AgentLaunchNotice } from '../../agents/presentation/AgentLaunchNotice'
import { PrTextLink } from '../review/pull-request/PrTextLink'
import type { MobileCommitFailureRecovery } from './mobile-commit-failure-recovery'
import type { MobileCommitFailureRecoveryAction } from './use-mobile-commit-failure-recovery'
import { styles } from '../mobile-source-control-styles'

type Props = {
  failure: MobileCommitFailureRecovery
  action: MobileCommitFailureRecoveryAction
}

// A failed commit as one red line, like any other error here; Fix and Details are text actions on it.
export function MobileCommitFailurePanel({ failure, action }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [expanded, setExpanded] = useState(false)
  const detailsText = failure.error.trim()
  const summary = action.summary?.trim()

  return (
    <View style={styles.commitFailure}>
      <Text style={[styles.feedbackText, styles.feedbackError]}>
        {!summary
          ? t('sourceControl.commitFailurePanel.title', 'Commit failed')
          : // Most summaries already say the commit failed ("Commit failed.", "Lint failed during commit.").
            /commit/i.test(summary)
            ? summary
            : t('sourceControl.commitFailurePanel.failedWith', 'Commit failed: {{reason}}', {
                reason: summary
              })}
      </Text>
      <View style={styles.commitFailureLinks}>
        <PrTextLink
          accent
          icon={<Sparkles size={14} color={colors.accentBlue} strokeWidth={2.2} />}
          label={t('sourceControl.commitFailurePanel.fix', 'Fix')}
          onPress={() => void action.launch()}
          busy={action.launching}
          disabled={action.availability !== 'available'}
        />
        {action.hasDetails && detailsText ? (
          <PrTextLink
            label={
              expanded
                ? t('sourceControl.commitFailurePanel.hideDetails', 'Hide details')
                : t('sourceControl.commitFailurePanel.details', 'Details')
            }
            onPress={() => setExpanded((current) => !current)}
          />
        ) : null}
      </View>
      {expanded && detailsText ? (
        <Text style={styles.commitFailureDetailsText} selectable>
          {detailsText}
        </Text>
      ) : null}
      <AgentLaunchNotice
        availability={action.availability}
        success={action.launchSuccess}
        error={action.launchError}
        warning={action.launchWarning}
        undeliveredPrompt={action.undeliveredPrompt}
        opens={action.launchOpens}
        errorStyle={styles.commitFailureLaunchError}
      />
    </View>
  )
}
