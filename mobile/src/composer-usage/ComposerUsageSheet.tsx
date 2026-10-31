import { Text, View } from 'react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { useNow } from '../hooks/use-now'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { USAGE_PROVIDER_NAMES, type AgentUsage } from './agent-usage-provider'
import { ComposerUsageWindowPicker } from './ComposerUsageWindowPicker'
import { ComposerUsageWindowRow } from './ComposerUsageWindowRow'

type Props = { visible: boolean; onClose: () => void; usage: AgentUsage }

export function ComposerUsageSheet({ visible, onClose, usage }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const now = useNow(30_000, visible)
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View testID="composer-usage-sheet">
        <Text style={styles.heading}>
          {t('composerUsage.sheet.title', '{{provider}} usage', {
            provider: USAGE_PROVIDER_NAMES[usage.provider]
          })}
        </Text>
        <Text style={styles.subtitle}>
          {t(
            'composerUsage.sheet.description',
            'Pace compares what you have used with an even burn across each window.'
          )}
        </Text>
        {usage.windows.map((entry) => (
          <ComposerUsageWindowRow key={entry.id} entry={entry} now={now} />
        ))}
        <ComposerUsageWindowPicker />
      </View>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  heading: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginTop: spacing.xs,
    marginBottom: spacing.sm
  }
}))
