import type { UsagePercentageDisplay } from '../../../../src/shared/agent-usage/display/usage-percentage-display'
import { getProviderDisplayName } from '../../../../src/shared/agent-usage/display/usage-provider-windows'
import { formatResetDuration } from '../../../../src/shared/agent-usage/rate-limits/rate-limit-reset-format'
import { formatUsageBarValue, usageBarFill } from '../../accounts/usage/UsageBar'
import type { Translate } from '../../i18n/mobile-i18n'
import { formatCompactUnit } from '../../worktree/agent-lineage/agent-row-display'
import { formatUsageUpdated } from '../tabs/home-usage-updated-label'
import { paletteForScheme, type MobileColorScheme } from '../../theme/mobile-theme'
import type { UsageWidgetSummary } from './usage-widget-summary'

/** A value per color scheme; the widget picks one at render time. */
export type UsageWidgetSchemed = Record<MobileColorScheme, string>

export type UsageWidgetMeter = {
  value: string
  /** The bar's fill, 0 to 1, of the shown percentage (used or remaining). */
  fill: number
  color: UsageWidgetSchemed
  /** "Resets in 3h 51m" as of this entry, in the app's language. */
  resets?: string
}

export type UsageWidgetAgent = {
  id: string
  title: string
  /** The app's mark as a PNG in the shared widget folder, per color scheme. */
  icon?: UsageWidgetSchemed
  /** The higher of the two windows' used percent, for the automatic "most used" pick. */
  peak: number
  session?: UsageWidgetMeter
  weekly?: UsageWidgetMeter
}

export type UsageWidgetHost = {
  id: string
  name: string
  updatedAt: number
  /** "Updated 5m ago" as of this entry, as the Usage tab shows it. */
  updated: string
  stale: boolean
  agents: UsageWidgetAgent[]
}

export type UsageWidgetPalette = {
  background: string
  primary: string
  secondary: string
  track: string
  /** The app's letter mark tile, for agents without an icon. */
  letterTile: string
}

/** Everything the widget draws, precomputed for one timeline entry: the widget runtime can't import app code.
 * Absent values are left out, never null: expo-widgets stores props in UserDefaults, which rejects NSNull. */
// Bump when the props shape changes; the widget shows its placeholder for any other version.
export const USAGE_WIDGET_PROPS_VERSION = 3

export type UsageWidgetProps = {
  v: typeof USAGE_WIDGET_PROPS_VERSION
  /** Most recently updated first, which the automatic desktop choice shows. */
  hosts: UsageWidgetHost[]
  url: string
  labels: {
    session: string
    weekly: string
    empty: string
  }
  palettes: Record<MobileColorScheme, UsageWidgetPalette>
}

export type UsageWidgetWindowChoice = 'automatic' | 'session' | 'weekly' | 'both'

/** The widget's edit settings, as `environment.configuration`; option values come from setConfigurationParameterEnum. */
export type UsageWidgetConfiguration = {
  desktop?: string | null
  /** "automatic" shows the most used; "custom" uses the agents rows. */
  agentMode?: 'automatic' | 'custom' | null
  agents?: string[] | null
  window?: UsageWidgetWindowChoice | null
}

export const USAGE_WIDGET_AUTOMATIC_DESKTOP = 'automatic'
// The app refreshes the widget only while it is open and connected, so old numbers fade instead of passing as live.
export const USAGE_WIDGET_STALE_AFTER_MS = 60 * 60_000

const MINUTE_MS = 60_000
// Times are text, so the widget needs an entry wherever a minute ticks over. The widget redraws every
// entry when its settings change, so the timeline stays near a hundred: each minute for the first hour,
// then every 15 minutes for half a day. Opening the app writes a fresh one.
const MINUTE_ENTRIES_FOR_MS = 60 * MINUTE_MS
const SPARSE_ENTRY_EVERY_MS = 15 * MINUTE_MS
const TIMELINE_SPAN_MS = 12 * 60 * MINUTE_MS

function schemed(pick: (scheme: MobileColorScheme) => string): UsageWidgetSchemed {
  return { light: pick('light'), dark: pick('dark') }
}

function widgetPalette(scheme: MobileColorScheme): UsageWidgetPalette {
  const palette = paletteForScheme(scheme)
  return {
    background: palette.bgPanel,
    primary: palette.textPrimary,
    secondary: palette.textSecondary,
    track: palette.bgRaised,
    // MobileAgentIcon's letter fallback: textMuted at 20%.
    letterTile: `${palette.textMuted}33`
  }
}

type SummaryWindow = UsageWidgetSummary['hosts'][number]['providers'][number]['session']

function widgetMeter(
  window: SummaryWindow,
  now: number,
  display: UsagePercentageDisplay,
  t: Translate
): UsageWidgetMeter | undefined {
  if (!window) {
    return undefined
  }
  // A window past its reset no longer holds the saved number.
  const current = window.resetsAt == null || window.resetsAt > now ? window : null
  const used = current?.usedPercent ?? null
  const { shown } = usageBarFill(used, current === null, display)
  return {
    value: formatUsageBarValue(shown, display, t),
    fill: (shown ?? 0) / 100,
    color: schemed(
      (scheme) => usageBarFill(used, current === null, display, paletteForScheme(scheme)).color
    ),
    ...(current?.resetsAt == null
      ? {}
      : {
          // The Usage tab's "3h 51m" in the app's units; under a minute still reads "1m", not "0m".
          resets: t('home.usage.widgetResetsIn', 'Resets in {{duration}}', {
            duration: formatResetDuration(
              Math.max(current.resetsAt - now, MINUTE_MS),
              (value, unit) => formatCompactUnit(value, unit, t)
            )
          })
        })
  }
}

function widgetLabels(t: Translate): UsageWidgetProps['labels'] {
  return {
    session: t('accounts.screen.sessionWindow', '5h'),
    weekly: t('accounts.screen.weeklyWindow', '7d'),
    empty: t('home.usage.pairDesktop', 'Pair a desktop to see agent account usage.')
  }
}

function widgetProps(input: {
  summary: UsageWidgetSummary
  now: number
  display: UsagePercentageDisplay
  icons: Readonly<Record<string, UsageWidgetSchemed>>
  url: string
  t: Translate
}): UsageWidgetProps {
  const { now, display, t } = input
  const hosts = input.summary.hosts
    .map((host): UsageWidgetHost => {
      const updatedAt = Math.min(
        now,
        Math.max(...host.providers.map((provider) => provider.updatedAt))
      )
      return {
        id: host.id,
        name: host.name,
        updatedAt,
        updated: formatUsageUpdated(updatedAt, now, t),
        stale: now - updatedAt > USAGE_WIDGET_STALE_AFTER_MS,
        agents: host.providers.map((provider): UsageWidgetAgent => {
          const icon = input.icons[provider.provider]
          const session = widgetMeter(provider.session, now, display, t)
          const weekly = widgetMeter(provider.weekly, now, display, t)
          return {
            id: provider.provider,
            title: getProviderDisplayName(provider.provider),
            peak: Math.max(provider.session?.usedPercent ?? -1, provider.weekly?.usedPercent ?? -1),
            ...(icon ? { icon } : {}),
            ...(session ? { session } : {}),
            ...(weekly ? { weekly } : {})
          }
        })
      }
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
  return {
    v: USAGE_WIDGET_PROPS_VERSION,
    hosts,
    url: input.url,
    labels: widgetLabels(t),
    palettes: { light: widgetPalette('light'), dark: widgetPalette('dark') }
  }
}

/** One entry per minute for the first hour and every 15 minutes after that, plus the moments a
 * desktop's numbers fade or a window resets. */
export function buildUsageWidgetTimeline(input: {
  summary: UsageWidgetSummary
  now: number
  display: UsagePercentageDisplay
  icons: Readonly<Record<string, UsageWidgetSchemed>>
  url: string
  t: Translate
}): { date: Date; props: UsageWidgetProps }[] {
  const end = input.now + TIMELINE_SPAN_MS
  const ticks: number[] = []
  for (let time = input.now; time <= end;) {
    ticks.push(time)
    time += time - input.now < MINUTE_ENTRIES_FOR_MS ? MINUTE_MS : SPARSE_ENTRY_EVERY_MS
  }
  const changes = input.summary.hosts.flatMap((host) => [
    Math.max(...host.providers.map((provider) => provider.updatedAt)) + USAGE_WIDGET_STALE_AFTER_MS,
    ...host.providers.flatMap((provider) =>
      [provider.session?.resetsAt, provider.weekly?.resetsAt].filter((time) => time != null)
    )
  ])
  const times = [
    ...new Set([...ticks, ...changes.filter((time) => time > input.now && time <= end)])
  ].sort((left, right) => left - right)
  return times.map((now) => ({ date: new Date(now), props: widgetProps({ ...input, now }) }))
}
