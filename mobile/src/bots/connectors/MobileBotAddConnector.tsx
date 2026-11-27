// Add a connector, as a page inside Connectors: the desktop's AddConnectorDialog as one grouped list, with search
// and the category filter in the bar under the thumb, as Tasks has them. Lists what the phone can add: Orca's
// connectors, the apps Add to <bot> lists, Composio's apps, then Add by URL. A tap adds; one already on the bot
// says Added and opens its page.
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import {
  BOT_APP_CATEGORIES,
  BOT_MCP_APPS,
  type BotAppCategory,
  type BotMcpApp
} from '../../../../src/shared/bots/bot-mcp-apps'
import { useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { Plus, SlidersHorizontal, Webhook } from 'lucide-react-native'
import { MobileNoMatchState } from '../../components/feedback/MobileStateView'
import { LIST_LEADING_INSET, ListRow } from '../../components/list/ListGroup'
import { BottomSearchBar } from '../../components/nav-bar/BottomSearchBar'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useSheetPageFooter } from '../../components/nav-bar/sheet-page-scroll'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { radii } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { MobileConnectorLogo } from '../MobileConnectorSourceIcon'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { AppLogo } from './MobileBotComposio'
import { useComposioCatalog } from './use-composio-catalog'
import { botMcpAppLine, composioCuratedAppLine } from '../../../../src/shared/bots/bot-app-lines'

type Filter = BotAppCategory | 'mine' | null

/** One row; `added` rows open the bot's own page for it, the rest add it. */
export type AddConnectorOption = {
  id: 'slack' | 'github' | 'linear' | 'google' | 'webhooks'
  added: boolean
  /** Added and can take another workspace or org here. */
  addAnother?: () => void
  /** Not added: how the phone adds it; none hides the row. */
  add?: () => void
  manage: () => void
}

/** Popular apps the desktop offers through Composio before the full catalog. */
const COMPOSIO_SHOWN = 6
const ICON = 20

const CATEGORY: Record<AddConnectorOption['id'], BotAppCategory | null> = {
  github: 'coding',
  slack: 'chat',
  linear: 'docs',
  google: 'mail',
  webhooks: null
}

/** An app's own logo, its corners rounded so a full-square logo reads as a small app tile. */
export function AppLogoMark({ slug }: { slug: string }) {
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={styles.logo}>
      <AppLogo slug={slug} size={ICON} />
    </View>
  )
}

export function MobileBotAddConnector(props: {
  botName: string
  options: readonly AddConnectorOption[]
  disabled: boolean
  banner: ReactNode
  onBack: () => void
  composio: {
    curated: readonly { slug: string; name: string; line: string }[]
    /** Apps the bot is signed in to. */
    active: readonly string[]
    /** The host has a key, so Composio's whole catalog can be searched. */
    catalog: { client: RpcClient | null; botId: string } | null
    onPick: (app: { slug: string; name: string }) => void
  }
  apps: {
    /** The ids of the listed apps the bot has as tools. */
    added: ReadonlySet<string>
    onPick: (app: BotMcpApp) => void
    onAddByUrl: () => void
  }
}) {
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const [query, setQuery] = useState('')
  const [picked, setFilter] = useState<Filter>(null)
  const [filtering, setFiltering] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [barHeight, setBarHeight] = useState(0)
  useBackClaim(() => {
    if (filtering) {
      setFiltering(false)
    } else {
      props.onBack()
    }
    return true
  })
  const copy: Record<AddConnectorOption['id'], { name: string; line: string; icon: ReactNode }> = {
    slack: {
      name: BOT_CONNECTOR_NAMES.slack,
      line: t('bots.apps.line.slack', 'Messages and mentions'),
      icon: <MobileConnectorLogo source="slack" size={ICON} />
    },
    github: {
      name: BOT_CONNECTOR_NAMES.github,
      line: t('bots.apps.line.github', 'Mentions and events on issues and PRs'),
      icon: <MobileConnectorLogo source="github" size={ICON} />
    },
    linear: {
      name: BOT_CONNECTOR_NAMES.linear,
      line: t('bots.apps.line.linear', 'Assigned issues and mentions'),
      icon: <MobileConnectorLogo source="linear" size={ICON} />
    },
    google: {
      name: BOT_CONNECTOR_NAMES.google,
      line: t('bots.apps.line.google', 'Gmail, Calendar and Drive, as you'),
      icon: <MobileConnectorLogo source="google" size={ICON} />
    },
    webhooks: {
      name: t('bots.webhooks.name', 'Webhooks'),
      line: t('bots.apps.webhooks.line', 'Events from any tool or script'),
      icon: <Webhook size={ICON} color={colors.textSecondary} />
    }
  }
  const categoryLabel: Record<BotAppCategory, string> = {
    coding: t('bots.apps.category.coding', 'Coding'),
    chat: t('bots.apps.category.chat', 'Chat'),
    docs: t('bots.apps.category.docs', 'Docs and projects'),
    mail: t('bots.apps.category.mail', 'Mail and meetings'),
    monitoring: t('bots.apps.category.monitoring', 'Monitoring'),
    sales: t('bots.apps.category.sales', 'Sales and support'),
    design: t('bots.apps.category.design', 'Design')
  }
  const mineLabel = t('bots.apps.onBot', 'On {{bot}}', { bot: props.botName })
  const listed = props.options.filter((option) => option.added || option.add)
  const needle = query.trim().toLocaleLowerCase()
  // In Add to <bot>'s order: by category, then as listed.
  const mcpApps = BOT_APP_CATEGORIES.flatMap((category) =>
    BOT_MCP_APPS.filter((app) => app.category === category)
  )
  const mineCount =
    listed.filter((option) => option.added).length +
    mcpApps.filter((app) => props.apps.added.has(app.id)).length
  // On <bot> lapses once nothing is on it.
  const filter = picked === 'mine' && mineCount === 0 ? null : picked
  const shown = listed.filter(
    (option) =>
      (filter === null || (filter === 'mine' ? option.added : CATEGORY[option.id] === filter)) &&
      (needle === '' ||
        `${copy[option.id].name} ${copy[option.id].line}`.toLocaleLowerCase().includes(needle))
  )
  const mcpShown = mcpApps.filter(
    (app) =>
      (filter === null ||
        (filter === 'mine' ? props.apps.added.has(app.id) : app.category === filter)) &&
      (needle === '' || `${app.name} ${botMcpAppLine(app, t)}`.toLocaleLowerCase().includes(needle))
  )
  const { composio } = props
  const added = (slug: string) => composio.active.includes(slug)
  // An app listed above is offered there, not again under Composio, as the desktop does.
  const direct = new Set(mcpApps.flatMap((app) => app.composio ?? []))
  // Browsing or searching with a key reads Composio's whole catalog, as the desktop's does.
  const fromCatalog = composio.catalog !== null && (browsing || needle !== '') && filter === null
  const catalog = useComposioCatalog(
    composio.catalog?.client ?? null,
    composio.catalog?.botId ?? '',
    fromCatalog ? query.trim() : null
  )
  const curated = new Map(composio.curated.map((app) => [app.slug, app]))
  const apps: readonly { slug: string; name: string }[] = fromCatalog
    ? catalog.apps
    : composio.curated.filter(
        (app) =>
          // Unless signed in already: that sign-in is the bot's, listed as Added.
          (!direct.has(app.slug) || added(app.slug)) &&
          (filter === null || (filter === 'mine' && added(app.slug))) &&
          (needle === '' ||
            `${app.name} ${composioCuratedAppLine(app, t)}`.toLocaleLowerCase().includes(needle))
      )
  const appsShown = fromCatalog || browsing || needle !== '' ? apps : apps.slice(0, COMPOSIO_SHOWN)
  const categories = BOT_APP_CATEGORIES.filter(
    (category) =>
      listed.some((option) => CATEGORY[option.id] === category) ||
      mcpApps.some((app) => app.category === category)
  )
  const filterLabel = filter === null ? null : filter === 'mine' ? mineLabel : categoryLabel[filter]
  const addedValue = t('bots.apps.added', 'Added')

  useSheetPageFooter(
    filtering ? null : (
      <BottomSearchBar
        value={query}
        onChangeText={setQuery}
        placeholder={t('bots.apps.search', 'Search apps')}
        bottomInset={0}
        inSheet
        onCoveredHeightChange={setBarHeight}
        leading={{
          icon: SlidersHorizontal,
          accessibilityLabel: filterLabel
            ? t('bots.apps.filterActive', 'Filter, {{filter}}', { filter: filterLabel })
            : t('bots.apps.filter', 'Filter'),
          onPress: () => setFiltering(true),
          badge: filter === null ? 0 : 1
        }}
      />
    )
  )

  if (filtering) {
    const choice = (value: Filter, label: string) => (
      <ListRow
        key={value ?? 'all'}
        title={label}
        selected={filter === value}
        onPress={() => setFilter(value)}
      />
    )
    return (
      <>
        <SheetHeader
          title={t('bots.apps.filter', 'Filter')}
          trailing={{ label: t('common.done', 'Done'), onPress: () => setFiltering(false) }}
        />
        <SettingsSection first radioGroup>
          {choice(null, t('bots.apps.all', 'All apps'))}
          {mineCount > 0 ? choice('mine', mineLabel) : null}
          {categories.map((category) => choice(category, categoryLabel[category]))}
        </SettingsSection>
      </>
    )
  }

  const nothing =
    shown.length === 0 && mcpShown.length === 0 && apps.length === 0 && !catalog.loading
  return (
    <>
      <SheetHeader
        title={t('settings.bots.addConnector', 'Add a connector')}
        subtitle={props.botName}
        onBack={{ label: t('bots.connectors.back', 'Back to Connectors'), onPress: props.onBack }}
      />
      {props.banner}
      {nothing ? (
        <MobileNoMatchState
          message={t('bots.apps.noMatch', 'No app matches “{{query}}”.', { query: query.trim() })}
        />
      ) : (
        <>
          {shown.length > 0 ? (
            <SettingsSection
              title={t('bots.apps.connectors', 'Connectors')}
              first
              separatorInset={LIST_LEADING_INSET}
            >
              {shown.map((option) => {
                const { name, line, icon } = copy[option.id]
                return (
                  <ListRow
                    key={option.id}
                    leading={icon}
                    title={name}
                    subtitle={line}
                    subtitleLines={1}
                    value={option.added ? addedValue : undefined}
                    navigates
                    disabled={props.disabled && !(option.added && !option.addAnother)}
                    onPress={option.added ? (option.addAnother ?? option.manage) : option.add}
                  />
                )
              })}
            </SettingsSection>
          ) : null}
          {mcpShown.length > 0 ? (
            <SettingsSection
              title={t('bots.apps.appsCaption', 'Apps')}
              first={shown.length === 0}
              separatorInset={LIST_LEADING_INSET}
            >
              {mcpShown.map((app) => {
                const onBot = props.apps.added.has(app.id)
                return (
                  <ListRow
                    key={app.id}
                    leading={<AppLogoMark slug={app.id} />}
                    title={app.name}
                    subtitle={botMcpAppLine(app, t)}
                    subtitleLines={1}
                    value={onBot ? addedValue : undefined}
                    navigates
                    disabled={props.disabled && !onBot}
                    onPress={() => props.apps.onPick(app)}
                  />
                )
              })}
            </SettingsSection>
          ) : null}
          {apps.length > 0 || fromCatalog ? (
            <SettingsSection
              title={t('bots.composio.group', 'More apps with Composio')}
              first={shown.length === 0 && mcpShown.length === 0}
              separatorInset={LIST_LEADING_INSET}
            >
              {appsShown.map((app) => {
                const own = curated.get(app.slug)
                return (
                  <ListRow
                    key={app.slug}
                    leading={<AppLogoMark slug={app.slug} />}
                    title={app.name}
                    subtitle={own ? composioCuratedAppLine(own, t) : undefined}
                    subtitleLines={1}
                    value={added(app.slug) ? addedValue : undefined}
                    navigates
                    disabled={props.disabled}
                    onPress={() => composio.onPick(app)}
                  />
                )
              })}
              {fromCatalog && catalog.loading ? (
                <ListRow
                  leading={null}
                  title={t('bots.composio.loading', 'Reading Composio’s apps…')}
                />
              ) : fromCatalog && catalog.failed ? (
                <ListRow
                  leading={null}
                  title={t('bots.composio.unreadShort', 'Couldn’t load Composio’s apps.')}
                />
              ) : catalog.more ? (
                <ListRow
                  leading={null}
                  title={t('bots.composio.showMore', 'Show more')}
                  onPress={catalog.more}
                />
              ) : !fromCatalog && appsShown.length < apps.length ? (
                <ListRow
                  leading={null}
                  title={t('bots.apps.composio.browseAll', 'Browse Composio apps')}
                  navigates
                  onPress={() => setBrowsing(true)}
                />
              ) : null}
            </SettingsSection>
          ) : null}
        </>
      )}
      <SettingsSection separatorInset={LIST_LEADING_INSET}>
        <ListRow
          leading={<Plus size={18} color={colors.textMuted} />}
          title={t('bots.apps.addByUrl', 'Add by URL')}
          disabled={props.disabled}
          navigates
          onPress={props.apps.onAddByUrl}
        />
      </SettingsSection>
      <View style={{ height: barHeight }} />
    </>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  logo: { borderRadius: radii.mark, overflow: 'hidden' }
}))
