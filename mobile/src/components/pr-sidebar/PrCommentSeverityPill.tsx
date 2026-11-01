import { Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { PrCommentSeverity } from './pr-comment-severity'

// The severity a review bot gave its finding, outlined in the matching status colour.
export function PrCommentSeverityPill({ severity }: { severity: PrCommentSeverity }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const color =
    severity === 'critical'
      ? colors.statusRed
      : severity === 'major'
        ? colors.statusAmber
        : colors.textSecondary
  const label = {
    critical: t('pullRequest.screens.severityCritical', 'Critical'),
    major: t('pullRequest.screens.severityMajor', 'Major'),
    minor: t('pullRequest.screens.severityMinor', 'Minor'),
    trivial: t('pullRequest.screens.severityTrivial', 'Trivial')
  }[severity]
  return (
    <View style={[styles.severity, { borderColor: color }]}>
      <Text style={[styles.severityText, { color }]}>{label}</Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  severity: {
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1
  },
  severityText: { fontSize: typography.metaSize, fontWeight: '600' }
}))
