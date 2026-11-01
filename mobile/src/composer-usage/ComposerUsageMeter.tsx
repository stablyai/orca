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
import {
  ComposerUsageClientContext,
  ComposerUsageTabAgentContext
} from './composer-usage-client-context'
import { useComposerUsageDisplay } from './composer-usage-display-preference'
import { composerUsageMeterReadout } from './composer-usage-meter-readout'
import { useComposerUsageWindow } from './composer-usage-window-preference'
import { ComposerUsageSheet } from './ComposerUsageSheet'

type Props = {
  agent: string | null | undefined
  /** The chat composer spans the Duo's status column, so its sheet does too; the terminal's keeps clear of the rail. */
  spanSideStrip?: boolean
}

/** The composer action row's flexible gap, with the agent's usage meter centered in it. */
export function ComposerUsageSlot({ agent, spanSideStrip }: Props): React.JSX.Element {
  return (
    <View style={[composerInputStyles.actionSpacer, styles.slot]}>
      <ComposerUsageMeter agent={agent} spanSideStrip={spanSideStrip} />
    </View>
  )
}

export function ComposerUsageMeter({
  agent,
  spanSideStrip = false
}: Props): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const client = useContext(ComposerUsageClientContext)
  // Before a hook status names the agent, the host's own identification of the tab still does.
  const tabAgent = useContext(ComposerUsageTabAgentContext)
  const usageAgent = agent ?? tabAgent
  // Agentless tabs never open the accounts stream.
  const snapshot = useAccountsSnapshot(usageProviderForAgent(usageAgent) ? client : null)
  const choice = useComposerUsageWindow()
  const display = useComposerUsageDisplay()
  const [open, setOpen] = useState(false)
  const usage = selectAgentUsage(snapshot, usageAgent)
  // A missing chosen window (no 5-hour limit on the plan) falls back to the one the provider reports.
  const entry = usage ? pickComposerUsageWindow(usage.windows, choice) : null
  if (!usage || !entry) {
    return null
  }
  const readout = composerUsageMeterReadout(entry.window.usedPercent, display)
  const length = formatUsageWindowLength(entry.window.windowMinutes)
  const provider = USAGE_PROVIDER_NAMES[usage.provider]
  const showingRemaining = display === 'remaining'
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          showingRemaining
            ? t(
                'composerUsage.meter.labelRemaining',
                '{{provider}} {{window}} usage: {{percent}}% left. Show details',
                { provider, window: length, percent: readout.shown }
              )
            : t(
                'composerUsage.meter.label',
                '{{provider}} {{window}} usage: {{percent}}% used. Show details',
                { provider, window: length, percent: readout.shown }
              )
        }
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
            style={[
              styles.fill,
              {
                width: `${readout.shown}%`,
                backgroundColor: usageBandColor(readout.used)
              }
            ]}
          />
        </View>
        <Text style={styles.text} numberOfLines={1}>
          {showingRemaining
            ? t('composerUsage.meter.left', '{{percent}}% left', { percent: readout.shown })
            : `${readout.shown}%`}
        </Text>
      </Pressable>
      <ComposerUsageSheet
        visible={open}
        onClose={() => setOpen(false)}
        usage={usage}
        spanSideStrip={spanSideStrip}
      />
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
