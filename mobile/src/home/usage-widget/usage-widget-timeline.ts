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
  /** "Resets in 3h 51m" as of this entry; left out past the timeline's end, where it would stop counting. */
  resets?: string
}

export type UsageWidgetAgent = {
  id: string
  title: string
  /** The app's mark as a PNG in the shared widget folder, per color scheme. */
  icon?: UsageWidgetSchemed
  /** The higher of the two current windows' used percent, for the automatic "most used" pick. */
  peak: number
  /** When the desktop last sent this agent's numbers; the widget dates and dims by the agents it shows. */
  updatedAt: number
  /** "Updated 5m ago" as of this entry, or empty past the timeline's end, where it would stop counting. */
  updated: string
  stale: boolean
  session?: UsageWidgetMeter
  weekly?: UsageWidgetMeter
}

export type UsageWidgetHost = {
  id: string
  name: string
  updatedAt: number
  /** Opens the Usage tab on this desktop and refreshes it. */
  url: string
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
export const USAGE_WIDGET_PROPS_VERSION = 4

export type UsageWidgetProps = {
  v: typeof USAGE_WIDGET_PROPS_VERSION
  /** Most recently updated first, which the automatic desktop choice shows. */
  hosts: UsageWidgetHost[]
  /** Opens the Usage tab when no desktop is shown. */
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
// Times are text, so each entry fixes them until the next. The widget extension runs the layout's JS
// for every entry of every placed widget within a small CPU budget, so the timeline stays near 20
// entries: every 10 minutes to an hour, every 30 to 3 hours, then hourly. Opening the app writes a
// fresh one.
const TICK_STEPS: readonly (readonly [untilMs: number, everyMs: number])[] = [
  [60 * MINUTE_MS, 10 * MINUTE_MS],
  [3 * 60 * MINUTE_MS, 30 * MINUTE_MS],
  [Infinity, 60 * MINUTE_MS]
]
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

// A window past its reset no longer holds the saved number.
function currentWindow(window: SummaryWindow, now: number): SummaryWindow {
  return window && (window.resetsAt == null || window.resetsAt > now) ? window : null
}

function widgetMeter(
  window: SummaryWindow,
  now: number,
  counting: boolean,
  display: UsagePercentageDisplay,
  t: Translate
): UsageWidgetMeter | undefined {
  if (!window) {
    return undefined
  }
  const current = currentWindow(window, now)
  const used = current?.usedPercent ?? null
  const { shown } = usageBarFill(used, current === null, display)
  return {
    value: formatUsageBarValue(shown, display, t),
    fill: (shown ?? 0) / 100,
    color: schemed(
      (scheme) => usageBarFill(used, current === null, display, paletteForScheme(scheme)).color
    ),
    ...(current?.resetsAt == null || !counting
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

type TimelineInput = {
  summary: UsageWidgetSummary
  now: number
  display: UsagePercentageDisplay
  icons: Readonly<Record<string, UsageWidgetSchemed>>
  /** The Usage tab link, without a desktop when hostId is undefined. */
  linkFor: (hostId?: string) => string
  t: Translate
}

/** counting is false from the timeline's last entry on, which the widget keeps showing until the app
 * writes again: times would stand still there, so they are left out. */
function widgetProps(input: TimelineInput & { counting: boolean }): UsageWidgetProps {
  const { now, counting, display, t } = input
  const hosts = input.summary.hosts
    .map((host): UsageWidgetHost => ({
      id: host.id,
      name: host.name,
      updatedAt: Math.min(now, Math.max(...host.providers.map((provider) => provider.updatedAt))),
      url: input.linkFor(host.id),
      agents: host.providers.map((provider): UsageWidgetAgent => {
        const icon = input.icons[provider.provider]
        const session = widgetMeter(provider.session, now, counting, display, t)
        const weekly = widgetMeter(provider.weekly, now, counting, display, t)
        const updatedAt = Math.min(now, provider.updatedAt)
        return {
          id: provider.provider,
          title: getProviderDisplayName(provider.provider),
          peak: Math.max(
            currentWindow(provider.session, now)?.usedPercent ?? -1,
            currentWindow(provider.weekly, now)?.usedPercent ?? -1
          ),
          updatedAt,
          updated: counting ? formatUsageUpdated(updatedAt, now, t) : '',
          stale: now - updatedAt > USAGE_WIDGET_STALE_AFTER_MS,
          ...(icon ? { icon } : {}),
          ...(session ? { session } : {}),
          ...(weekly ? { weekly } : {})
        }
      })
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
  return {
    v: USAGE_WIDGET_PROPS_VERSION,
    hosts,
    url: input.linkFor(),
    labels: widgetLabels(t),
    palettes: { light: widgetPalette('light'), dark: widgetPalette('dark') }
  }
}

/** Entries thinning from every 10 minutes to hourly over half a day (see TICK_STEPS), plus the moments an
 * agent's numbers fade or a window resets, including resets after that, so a reset window never keeps
 * its old number. */
export function buildUsageWidgetTimeline(
  input: TimelineInput
): { date: Date; props: UsageWidgetProps }[] {
  const end = input.now + TIMELINE_SPAN_MS
  const ticks: number[] = []
  for (let time = input.now; time <= end;) {
    ticks.push(time)
    const elapsed = time - input.now
    time += (TICK_STEPS.find(([untilMs]) => elapsed < untilMs) ?? TICK_STEPS[0])[1]
  }
  const changes = input.summary.hosts.flatMap((host) =>
    host.providers.flatMap((provider) => [
      // stale is strictly past the hour, so the entry that dims sits just after it.
      provider.updatedAt + USAGE_WIDGET_STALE_AFTER_MS + 1,
      ...[provider.session?.resetsAt, provider.weekly?.resetsAt].filter((time) => time != null)
    ])
  )
  const times = [...new Set([...ticks, ...changes.filter((time) => time > input.now)])].sort(
    (left, right) => left - right
  )
  return times.map((now) => ({
    date: new Date(now),
    props: widgetProps({ ...input, now, counting: now < end })
  }))
}
