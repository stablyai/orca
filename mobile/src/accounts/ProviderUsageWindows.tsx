import { View } from 'react-native'
import { formatWindowLabel } from '../../../src/shared/rate-limit-window-label'
import {
  getUsageWindowSections,
  type UsageWindowSection
} from '../../../src/shared/usage-provider-windows'
import { UsageBar } from './usage/UsageBar'
import { getUsageBarState, getWindowResetLabel } from './usage/usage-selectors'
import type { ProviderRateLimits } from './accounts-snapshot'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10_080
const EMPTY_SECTIONS: UsageWindowSection[] = [
  { kind: 'session', window: null },
  { kind: 'weekly', window: null }
]

// The desktop roster's labels, except 5h and 7d use mobile's translated copy (desktop shows 7d as "wk").
function getWindowLabel(section: UsageWindowSection, t: Translate): string {
  if (section.kind === 'bucket') {
    return section.name
  }
  if (section.kind === 'fableWeekly') {
    return t('accounts.screen.fableWindow', 'Fable')
  }
  if (section.kind === 'mcp') {
    return t('accounts.screen.mcpWindow', 'MCP')
  }
  const minutes =
    section.window?.windowMinutes ??
    (section.kind === 'session' ? SESSION_WINDOW_MINUTES : WEEKLY_WINDOW_MINUTES)
  if (minutes === SESSION_WINDOW_MINUTES) {
    return t('accounts.screen.sessionWindow', '5h')
  }
  if (minutes === WEEKLY_WINDOW_MINUTES) {
    return t('accounts.screen.weeklyWindow', '7d')
  }
  return formatWindowLabel(minutes)
}

/** One bar per usage window desktop shows for this provider. */
export function ProviderUsageWindows({
  limits,
  now,
  isFetching,
  showEmptyWindows = false
}: {
  limits: ProviderRateLimits | null
  now: number
  isFetching?: boolean
  /** Account rows keep empty session/weekly bars so a not-yet-read account still shows its windows. */
  showEmptyWindows?: boolean
}) {
  const t = useMobileTranslation()
  const sections = (limits ? getUsageWindowSections(limits) : EMPTY_SECTIONS).filter(
    (section) => showEmptyWindows || section.window !== null
  )
  // Pool names can repeat when agy leaves a window unnamed, so count each name's occurrences.
  const seen = new Map<string, number>()
  return (
    <View style={styles.windows}>
      {sections.map((section) => {
        const name = section.kind === 'bucket' ? `bucket:${section.name}` : section.kind
        const occurrence = seen.get(name) ?? 0
        seen.set(name, occurrence + 1)
        const bar = getUsageBarState(limits, section.window, isFetching)
        const wide = section.kind === 'bucket'
        return (
          <UsageBar
            key={`${name}:${occurrence}`}
            label={getWindowLabel(section, t)}
            usedPercent={bar.usedPercent}
            unavailable={bar.unavailable}
            loading={bar.loading}
            resetText={getWindowResetLabel(section.window, now)}
            wideLabel={wide}
            style={wide ? styles.wideWindow : styles.window}
          />
        )
      })}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  windows: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: spacing.md,
    rowGap: spacing.sm,
    marginTop: spacing.xs
  },
  // Two windows share a line; a third wraps to its own.
  window: {
    flexBasis: '40%',
    flexGrow: 1
  },
  wideWindow: {
    flexBasis: '100%'
  }
}))
