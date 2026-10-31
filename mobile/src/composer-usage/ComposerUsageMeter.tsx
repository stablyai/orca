import { useContext, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { usageBandColor } from '../components/AccountUsage'
import { composerInputStyles } from '../components/composer-input/composer-input-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useAccountsSnapshot } from './accounts-snapshot-store'
import {
  formatUsageWindowLength,
  pickComposerUsageWindow,
  selectAgentUsage,
  usageProviderForAgent,
  USAGE_PROVIDER_NAMES
} from './agent-usage-provider'
import { ComposerUsageClientContext } from './composer-usage-client-context'
import { useComposerUsageWindow } from './composer-usage-window-preference'
import { ComposerUsageSheet } from './ComposerUsageSheet'

type Props = { agent: string | null | undefined }

/** The composer action row's flexible gap, with the agent's usage meter centered in it. */
export function ComposerUsageSlot({ agent }: Props): React.JSX.Element {
  return (
    <View style={[composerInputStyles.actionSpacer, styles.slot]}>
      <ComposerUsageMeter agent={agent} />
    </View>
  )
}

export function ComposerUsageMeter({ agent }: Props): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const client = useContext(ComposerUsageClientContext)
  // Agentless tabs never open the accounts stream.
  const snapshot = useAccountsSnapshot(usageProviderForAgent(agent) ? client : null)
  const choice = useComposerUsageWindow()
  const [open, setOpen] = useState(false)
  const usage = selectAgentUsage(snapshot, agent)
  const entry = usage ? pickComposerUsageWindow(usage.windows, choice) : null
  if (!usage || !entry) {
    return null
  }
  const used = Math.round(Math.max(0, Math.min(100, entry.window.usedPercent)))
  const length = formatUsageWindowLength(entry.window.windowMinutes)
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(
          'composerUsage.meter.label',
          '{{provider}} {{window}} usage: {{percent}}% used. Show details',
          { provider: USAGE_PROVIDER_NAMES[usage.provider], window: length, percent: used }
        )}
        hitSlop={6}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.meter, pressed && composerInputStyles.pressed]}
        testID="composer-usage-meter"
      >
        <Text style={styles.text} numberOfLines={1}>
          {length}
        </Text>
        <View style={styles.track}>
          <View
            style={[styles.fill, { width: `${used}%`, backgroundColor: usageBandColor(used) }]}
          />
        </View>
        <Text style={styles.text} numberOfLines={1}>
          {`${used}%`}
        </Text>
      </Pressable>
      <ComposerUsageSheet visible={open} onClose={() => setOpen(false)} usage={usage} />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  slot: {
    alignItems: 'center',
    minWidth: 0
  },
  meter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 28,
    maxWidth: '100%',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill
  },
  text: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  track: {
    flexShrink: 1,
    width: 36,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    overflow: 'hidden'
  },
  fill: {
    height: '100%',
    borderRadius: radii.pill
  }
}))
