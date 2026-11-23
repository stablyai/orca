// Add a connector, as a page inside Connectors: the desktop's AddConnectorDialog, built like Bot templates
// (search, category chips, one grouped list). Lists what the phone can add, and Manage for what the bot has:
// Orca's connectors, the apps Add to <bot> lists, Composio's apps, then Add by URL.
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import {
  BOT_APP_CATEGORIES,
  BOT_MCP_APPS,
  type BotAppCategory,
  type BotMcpApp
} from '../../../../src/shared/bots/bot-mcp-apps'
import { useState, type ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { Plus, Webhook, Wrench } from 'lucide-react-native'
import { MobileSearchField } from '../../components/controls/MobileSearchField'
import { MobileNoMatchState } from '../../components/feedback/MobileStateView'
import {
  LIST_LEADING_INSET,
  ListGroup,
  ListRow,
  SectionHeader
} from '../../components/list/ListGroup'
import { FilterChip } from '../../components/nav-bar/FilterChip'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { MobileConnectorSourceIcon, MobileGoogleMark } from '../MobileConnectorSourceIcon'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { AppLogo } from './MobileBotComposio'
import { useComposioCatalog } from './use-composio-catalog'

type Category = BotAppCategory

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

const CATEGORY: Record<AddConnectorOption['id'], Category | null> = {
  github: 'coding',
  slack: 'chat',
  linear: 'docs',
  google: 'mail',
  webhooks: null
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
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Category | 'mine' | null>(null)
  const [browsing, setBrowsing] = useState(false)
  useBackClaim(() => {
    props.onBack()
    return true
  })
  const copy: Record<AddConnectorOption['id'], { name: string; line: string; icon: ReactNode }> = {
    slack: {
      name: BOT_CONNECTOR_NAMES.slack,
      line: t('bots.apps.line.slack', 'Messages and mentions'),
      icon: <MobileConnectorSourceIcon source="slack" size={20} />
    },
    github: {
      name: BOT_CONNECTOR_NAMES.github,
      line: t('bots.apps.line.github', 'Mentions and events on issues and PRs'),
      icon: <MobileConnectorSourceIcon source="github" size={20} />
    },
    linear: {
      name: BOT_CONNECTOR_NAMES.linear,
      line: t('bots.apps.line.linear', 'Assigned issues and mentions'),
      icon: <MobileConnectorSourceIcon source="linear" size={20} />
    },
    google: {
      name: BOT_CONNECTOR_NAMES.google,
      line: t('bots.apps.line.google', 'Gmail, Calendar and Drive, as you'),
      icon: <MobileGoogleMark size={20} />
    },
    webhooks: {
      name: t('bots.webhooks.name', 'Webhooks'),
      line: t('bots.apps.webhooks.line', 'Events from any tool or script'),
      icon: <Webhook size={20} color={colors.textSecondary} />
    }
  }
  const categoryLabel: Record<Category, string> = {
    coding: t('bots.apps.category.coding', 'Coding'),
    chat: t('bots.apps.category.chat', 'Chat'),
    docs: t('bots.apps.category.docs', 'Docs and projects'),
    mail: t('bots.apps.category.mail', 'Mail and meetings'),
    monitoring: t('bots.apps.category.monitoring', 'Monitoring'),
    sales: t('bots.apps.category.sales', 'Sales and support'),
    design: t('bots.apps.category.design', 'Design')
  }
  const listed = props.options.filter((option) => option.added || option.add)
  const mine = listed.filter((option) => option.added)
  const needle = query.trim().toLocaleLowerCase()
  const shown = listed.filter(
    (option) =>
      (filter === null || (filter === 'mine' ? option.added : CATEGORY[option.id] === filter)) &&
      (needle === '' ||
        `${copy[option.id].name} ${copy[option.id].line}`.toLocaleLowerCase().includes(needle))
  )
  // In Add to <bot>'s order: by category, then as listed.
  const mcpApps = BOT_APP_CATEGORIES.flatMap((category) =>
    BOT_MCP_APPS.filter((app) => app.category === category)
  )
  const mcpMine = mcpApps.filter((app) => props.apps.added.has(app.id))
  const mcpShown = mcpApps.filter(
    (app) =>
      (filter === null ||
        (filter === 'mine' ? props.apps.added.has(app.id) : app.category === filter)) &&
      (needle === '' || `${app.name} ${app.line}`.toLocaleLowerCase().includes(needle))
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
  const apps: readonly { slug: string; name: string }[] = fromCatalog
    ? catalog.apps
    : composio.curated.filter(
        (app) =>
          // Unless signed in already: that sign-in is the bot's, listed with Manage.
          (!direct.has(app.slug) || added(app.slug)) &&
          (filter === null || (filter === 'mine' && added(app.slug))) &&
          (needle === '' || `${app.name} ${app.line}`.toLocaleLowerCase().includes(needle))
      )
  const appsShown = fromCatalog || browsing || needle !== '' ? apps : apps.slice(0, COMPOSIO_SHOWN)
  const categories = BOT_APP_CATEGORIES.filter(
    (category) =>
      listed.some((option) => CATEGORY[option.id] === category) ||
      mcpApps.some((app) => app.category === category)
  )
  const chip = (value: Category | 'mine' | null, label: string) => (
    <FilterChip
      key={value ?? 'all'}
      label={label}
      active={filter === value}
      onPress={() => setFilter(value)}
    />
  )
  return (
    <>
      <SheetHeader
        title={t('settings.bots.addConnector', 'Add a connector')}
        subtitle={props.botName}
        onBack={{ label: t('bots.connectors.back', 'Back to Connectors'), onPress: props.onBack }}
      />
      {props.banner}
      <MobileSearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t('bots.apps.search', 'Search apps')}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.chips}
        contentContainerStyle={styles.chipRow}
      >
        {chip(null, t('bots.apps.allShort', 'All'))}
        {mine.length + mcpMine.length > 0
          ? chip(
              'mine',
              `${t('bots.apps.onBot', 'On {{bot}}', { bot: props.botName })} ${mine.length + mcpMine.length}`
            )
          : null}
        {categories.map((category) => chip(category, categoryLabel[category]))}
      </ScrollView>
      {shown.length === 0 && mcpShown.length === 0 && apps.length === 0 && !catalog.loading ? (
        <MobileNoMatchState
          message={t('bots.apps.noMatch', 'No app matches “{{query}}”.', { query: query.trim() })}
          onClear={() => setQuery('')}
        />
      ) : (
        <View>
          {shown.length > 0 ? (
            <>
              <SectionHeader title={t('bots.apps.connectors', 'Connectors')} />
              <ListGroup separatorInset={LIST_LEADING_INSET}>
                {shown.map((option) => {
                  const { name, line, icon } = copy[option.id]
                  const action = option.added
                    ? option.addAnother
                      ? {
                          label:
                            option.id === 'github'
                              ? t('bots.connectors.addOrg', 'Add org')
                              : t('bots.connectors.addWorkspace', 'Add workspace'),
                          onPress: option.addAnother
                        }
                      : {
                          label: t('bots.connectors.manage', 'Manage'),
                          onPress: option.manage
                        }
                    : { label: t('bots.apps.add', 'Add'), onPress: option.add! }
                  return (
                    <ListRow
                      key={option.id}
                      leading={icon}
                      title={name}
                      subtitle={line}
                      onPress={option.added ? option.manage : option.add}
                      disabled={props.disabled && !option.added}
                      accessory={
                        <MobileBotTextButton
                          label={action.label}
                          disabled={props.disabled}
                          onPress={action.onPress}
                        />
                      }
                    />
                  )
                })}
              </ListGroup>
            </>
          ) : null}
          {mcpShown.length > 0 ? (
            <>
              <SectionHeader title={t('bots.apps.appsCaption', 'Apps')} />
              <ListGroup separatorInset={LIST_LEADING_INSET}>
                {mcpShown.map((app) => {
                  const onBot = props.apps.added.has(app.id)
                  return (
                    <ListRow
                      key={app.id}
                      leading={<Wrench size={20} color={colors.textSecondary} />}
                      title={app.name}
                      subtitle={app.line}
                      disabled={props.disabled && !onBot}
                      onPress={() => props.apps.onPick(app)}
                      accessory={
                        <MobileBotTextButton
                          label={
                            onBot
                              ? t('bots.connectors.manage', 'Manage')
                              : t('bots.apps.add', 'Add')
                          }
                          disabled={props.disabled}
                          onPress={() => props.apps.onPick(app)}
                        />
                      }
                    />
                  )
                })}
              </ListGroup>
            </>
          ) : null}
          {apps.length > 0 || fromCatalog ? (
            <>
              <SectionHeader title={t('bots.composio.group', 'More apps with Composio')} />
              <ListGroup separatorInset={LIST_LEADING_INSET}>
                {appsShown.map((app) => (
                  <ListRow
                    key={app.slug}
                    leading={<AppLogo slug={app.slug} size={20} />}
                    title={app.name}
                    subtitle={t('bots.composio.viaComposio', 'via Composio')}
                    disabled={props.disabled}
                    onPress={() => composio.onPick(app)}
                    accessory={
                      <MobileBotTextButton
                        label={
                          added(app.slug)
                            ? t('bots.connectors.manage', 'Manage')
                            : t('bots.apps.add', 'Add')
                        }
                        disabled={props.disabled}
                        onPress={() => composio.onPick(app)}
                      />
                    }
                  />
                ))}
                {fromCatalog && catalog.loading ? (
                  <ListRow title={t('bots.composio.loading', 'Reading Composio’s apps…')} />
                ) : fromCatalog && catalog.failed ? (
                  <ListRow
                    title={t('bots.composio.unreadShort', 'Couldn’t load Composio’s apps.')}
                  />
                ) : catalog.more ? (
                  <ListRow
                    title={t('bots.composio.showMore', 'Show more')}
                    onPress={catalog.more}
                  />
                ) : !fromCatalog && appsShown.length < apps.length ? (
                  <ListRow
                    title={t('bots.apps.composio.browseAll', 'Browse Composio apps')}
                    navigates
                    onPress={() => setBrowsing(true)}
                  />
                ) : null}
              </ListGroup>
            </>
          ) : null}
        </View>
      )}
      <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.byUrl}>
        <ListRow
          leading={<Plus size={20} color={colors.textPrimary} />}
          title={t('bots.apps.addByUrl', 'Add by URL')}
          disabled={props.disabled}
          navigates
          onPress={props.apps.onAddByUrl}
        />
      </ListGroup>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  chips: { flexGrow: 0, marginTop: spacing.xs },
  chipRow: { gap: spacing.sm },
  byUrl: { marginTop: spacing.lg }
}))
