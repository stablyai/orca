import AsyncStorage from '@react-native-async-storage/async-storage'
import { Directory, File } from 'expo-file-system'
import * as Linking from 'expo-linking'
import { widgetsDirectory } from 'expo-widgets'
import { useEffect, useRef, useState } from 'react'
import { Image, type ImageSourcePropType } from 'react-native'
import { getProviderDisplayName } from '../../../../src/shared/agent-usage/display/usage-provider-windows'
import { useUsagePercentageDisplay } from '../../accounts/usage/usage-percentage-display-preference'
import { MOBILE_AGENT_ICON_ASSETS } from '../../components/icons/mobile-agent-icon-assets'
import type { MobileColorScheme } from '../../theme/mobile-theme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { usageWidget } from './usage-widget-layout'
import {
  buildUsageWidgetSummary,
  parseUsageWidgetSummary,
  type UsageWidgetSummary
} from './usage-widget-summary'
import { buildUsageWidgetTimeline, USAGE_WIDGET_AUTOMATIC_DESKTOP } from './usage-widget-timeline'
import type { UsageWidgetSyncProps } from './UsageWidgetSync'

const SUMMARY_KEY = 'orca:usageWidgetSummary'
// Not a provider id, so the widget's agent lookup skips it.
const USAGE_WIDGET_NO_AGENT = 'none'

const iconAssets: Partial<Record<string, ImageSourcePropType>> = MOBILE_AGENT_ICON_ASSETS
// The usage provider id where it differs from the agent whose mark it shares.
const PROVIDER_ICON_AGENT: Readonly<Record<string, string>> = { 'opencode-go': 'opencode' }
// The widget can't draw SVG, so Claude and Codex use AgentIcons.tsx's paths rendered to PNG at 64px:
// Claude in its own color, Codex in each scheme's textPrimary (#0a0a0a light, #fafafa dark).
const SVG_MARKS: Readonly<Record<string, Record<MobileColorScheme, ImageSourcePropType>>> = {
  claude: {
    light: require('../../../assets/usage-widget/claude.png'),
    dark: require('../../../assets/usage-widget/claude.png')
  },
  codex: {
    light: require('../../../assets/usage-widget/codex-on-light.png'),
    dark: require('../../../assets/usage-widget/codex-on-dark.png')
  }
}

function iconSources(provider: string): Record<MobileColorScheme, ImageSourcePropType> | null {
  const source = iconAssets[PROVIDER_ICON_AGENT[provider] ?? provider]
  return SVG_MARKS[provider] ?? (source ? { light: source, dark: source } : null)
}

function iconsDirectory(): Directory | null {
  if (!widgetsDirectory) {
    return null
  }
  try {
    const directory = new Directory(widgetsDirectory, 'agent-icons')
    directory.create({ intermediates: true, idempotent: true })
    return directory
  } catch {
    return null
  }
}

// Copied once per app run, so a new build's marks replace the old files.
const copiedIcons = new Map<string, string>()

async function copyIcon(directory: Directory, name: string, source: ImageSourcePropType) {
  const copied = copiedIcons.get(name)
  if (copied) {
    return copied
  }
  const uri = Image.resolveAssetSource(source)?.uri
  if (!uri) {
    return null
  }
  const file = new File(directory, `${name}.png`)
  if (uri.startsWith('file:')) {
    file.create({ overwrite: true })
    file.writeSync(new File(uri).bytesSync())
  } else {
    // Development builds serve assets from Metro.
    await File.downloadFileAsync(uri, file, { idempotent: true })
  }
  copiedIcons.set(name, file.uri)
  return file.uri
}

async function bundledIcon(
  directory: Directory,
  provider: string
): Promise<Record<MobileColorScheme, string> | null> {
  const sources = iconSources(provider)
  if (!sources) {
    return null
  }
  const light = await copyIcon(directory, `${provider}-light`, sources.light)
  const dark = await copyIcon(directory, `${provider}-dark`, sources.dark)
  return light && dark ? { light, dark } : null
}

/** Hands Home's live usage to the iOS widget, which never talks to a desktop itself. */
export function UsageWidgetSync({ hosts, hostsLoaded, accountsByHost }: UsageWidgetSyncProps) {
  const t = useMobileTranslation()
  const display = useUsagePercentageDisplay()
  const [restored, setRestored] = useState(false)
  // The last summary built, so a desktop that goes offline keeps the numbers it last sent.
  const latest = useRef<UsageWidgetSummary | null>(null)
  const lastKey = useRef<string | null>(null)

  // A failed read is not an empty summary: writing one would drop the offline desktops' numbers, so
  // the widget keeps what it shows and the next Home update reads again.
  const reading = useRef(false)
  useEffect(() => {
    if (restored || reading.current) {
      return
    }
    reading.current = true
    AsyncStorage.getItem(SUMMARY_KEY)
      .then((raw) => {
        latest.current = parseUsageWidgetSummary(raw)
        setRestored(true)
      })
      .catch(() => undefined)
      .finally(() => {
        reading.current = false
      })
  }, [restored, hosts, accountsByHost])

  useEffect(() => {
    // A desktop list not yet read, or whose read failed, would read as "all unpaired" and wipe the widget.
    if (!hostsLoaded || !restored) {
      return
    }
    let cancelled = false
    const summary = buildUsageWidgetSummary({
      hosts,
      liveSnapshots: accountsByHost,
      previous: latest.current
    })
    latest.current = summary
    const providers = [
      ...new Set(summary.hosts.flatMap((host) => host.providers.map((p) => p.provider)))
    ]
    void (async () => {
      const directory = iconsDirectory()
      const icons: Record<string, Record<MobileColorScheme, string>> = {}
      for (const provider of providers) {
        const uri = directory ? await bundledIcon(directory, provider).catch(() => null) : null
        if (uri) {
          icons[provider] = uri
        }
      }
      const now = Date.now()
      const entries = buildUsageWidgetTimeline({
        summary,
        now,
        display,
        icons,
        linkFor: (hostId) =>
          Linking.createURL('/', {
            queryParams: { tab: 'usage', ...(hostId ? { host: hostId } : {}) }
          }),
        t
      })
      const desktopOptions = [
        {
          name: t('home.usage.widgetAutomaticDesktop', 'Most recently updated'),
          value: USAGE_WIDGET_AUTOMATIC_DESKTOP
        },
        // One desktop leaves nothing to choose.
        ...(summary.hosts.length > 1
          ? summary.hosts.map((host) => ({ name: host.name, value: host.id }))
          : [])
      ]
      const agentOptions = [
        // Fixed-size rows can't be emptied once set; this clears one, and the widget skips it.
        { name: t('home.usage.widgetNoAgent', 'None'), value: USAGE_WIDGET_NO_AGENT },
        ...providers.map((provider) => ({
          name: getProviderDisplayName(provider),
          value: provider
        }))
      ]
      const key = JSON.stringify([
        // The entries spell out times and run for half a day, so unchanged content is still rewritten hourly.
        Math.floor(now / 3_600_000),
        summary,
        display,
        icons,
        entries[0]?.props.labels,
        desktopOptions
      ])
      if (cancelled || key === lastKey.current) {
        return
      }
      // Native failures surface as "Exception in HostFunction: <unknown>", so name the call.
      const call = (name: string, run: () => void) => {
        try {
          run()
        } catch (error) {
          throw new Error(`${name} failed: ${String(error)}`)
        }
      }
      call('setConfigurationParameterEnum(desktop)', () =>
        usageWidget.setConfigurationParameterEnum('desktop', desktopOptions)
      )
      call('setConfigurationParameterEnum(agents)', () =>
        usageWidget.setConfigurationParameterEnum('agents', agentOptions)
      )
      call('updateTimeline', () => usageWidget.updateTimeline(entries))
      lastKey.current = key
      await AsyncStorage.setItem(SUMMARY_KEY, JSON.stringify(summary))
    })().catch((error: unknown) => console.warn('Usage widget could not be updated', error))
    return () => {
      cancelled = true
    }
  }, [hosts, hostsLoaded, accountsByHost, restored, display, t])

  return null
}
