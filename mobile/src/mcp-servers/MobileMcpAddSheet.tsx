// Add an MCP server: Custom server on top, then the apps the desktop's Add dialog lists, with search
// and the category filter in the bar under the thumb, as Add a connector has them. An app already on
// the host says Added and opens its page; one that takes a token opens Custom server filled in.
import { useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { Plus, SlidersHorizontal, X } from 'lucide-react-native'
import { botMcpAppLine } from '../../../src/shared/bots/bot-app-lines'
import { botMcpAppUrl } from '../../../src/shared/bots/bot-mcp-apps'
import {
  MCP_SERVER_CATALOG,
  MCP_SERVER_CATALOG_CATEGORIES,
  type McpServerCatalogCategory,
  type McpServerCatalogEntry
} from '../../../src/shared/mcp-servers/mcp-server-catalog'
import { MobileNoMatchState } from '../components/feedback/MobileStateView'
import { LIST_LEADING_INSET, ListRow } from '../components/list/ListGroup'
import { BottomSearchBar } from '../components/nav-bar/BottomSearchBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useSheetPageFooter } from '../components/nav-bar/sheet-page-scroll'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileMcpCustomServerPage, type McpCustomPreset } from './MobileMcpCustomServerPage'
import { mcpServerAdd, type PhoneMcpServer } from './mcp-server-operations'
import { McpAppLogo } from './mcp-server-row-parts'
import { mcpCatalogEntryOf } from './mcp-server-words'

type Page = { kind: 'catalog' } | { kind: 'filter' } | { kind: 'custom'; preset?: McpCustomPreset }

export function MobileMcpAddSheet(props: {
  client: RpcClient | null
  hostName: string
  servers: readonly PhoneMcpServer[]
  online: boolean
  onClose: () => void
  /** A server on the host now, added here or already there: its page opens. */
  onOpen: (server: PhoneMcpServer) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [page, setPage] = useState<Page>({ kind: 'catalog' })
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<McpServerCatalogCategory | null>(null)
  const [barHeight, setBarHeight] = useState(0)
  const [adding, setAdding] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = useRef(true)
  useEffect(
    () => () => {
      open.current = false
    },
    []
  )
  const taken = useMemo(() => new Set(props.servers.map((server) => server.name)), [props.servers])
  useBackClaim(() => {
    if (page.kind === 'filter') {
      setPage({ kind: 'catalog' })
    } else if (page.kind === 'catalog') {
      props.onClose()
    }
    // Custom server claims its own Back.
    return page.kind !== 'custom'
  })
  const categoryLabel: Record<McpServerCatalogCategory, string> = {
    coding: t('mcpServers.category.coding', 'Coding'),
    chat: t('mcpServers.category.chat', 'Chat'),
    monitoring: t('mcpServers.category.monitoring', 'Monitoring'),
    docs: t('mcpServers.category.docs', 'Docs and projects'),
    more: t('mcpServers.category.more', 'More')
  }
  const onHost = (entry: McpServerCatalogEntry) =>
    props.servers.find((server) => mcpCatalogEntryOf(server)?.id === entry.id)
  const needle = query.trim().toLocaleLowerCase()
  const shown = MCP_SERVER_CATALOG_CATEGORIES.flatMap((category) =>
    MCP_SERVER_CATALOG.filter((entry) => entry.category === category)
  ).filter(
    (entry) =>
      (filter === null || entry.category === filter) &&
      (needle === '' ||
        `${entry.name} ${botMcpAppLine(entry, t)}`.toLocaleLowerCase().includes(needle))
  )
  const categories = MCP_SERVER_CATALOG_CATEGORIES.filter((category) =>
    MCP_SERVER_CATALOG.some((entry) => entry.category === category)
  )

  useSheetPageFooter(
    page.kind === 'catalog' ? (
      <BottomSearchBar
        value={query}
        onChangeText={setQuery}
        placeholder={t('mcpServers.searchApps', 'Search apps')}
        bottomInset={0}
        inSheet
        onCoveredHeightChange={setBarHeight}
        leading={{
          icon: SlidersHorizontal,
          accessibilityLabel: filter
            ? t('mcpServers.filterActive', 'Filter, {{filter}}', { filter: categoryLabel[filter] })
            : t('mcpServers.filter', 'Filter'),
          onPress: () => setPage({ kind: 'filter' }),
          badge: filter === null ? 0 : 1
        }}
      />
    ) : null
  )

  const pick = (entry: McpServerCatalogEntry) => {
    // One add at a time: its answer opens its page, which would close a form opened meanwhile.
    if (adding !== null) {
      return
    }
    const added = onHost(entry)
    if (added) {
      props.onOpen(added)
      return
    }
    const source = botMcpAppUrl(entry)
    // A token to paste, or a site to pick: Custom server shows them before Add.
    if (entry.headers || entry.variable) {
      setPage({ kind: 'custom', preset: { source, name: entry.id, headers: entry.headers ?? [] } })
      return
    }
    if (!props.client) {
      return
    }
    setAdding(entry.id)
    setError(null)
    void mcpServerAdd
      .request(props.client, { source, name: entry.id }, { failWhenDisconnected: true })
      .then((reply) => {
        const server = mcpServerAdd.interpret(reply).server
        // Closed meanwhile: the server is on the list, but nothing opens over where the user went.
        if (open.current) {
          props.onOpen(server)
        }
      })
      .catch((caught: unknown) => {
        if (open.current) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      })
      .finally(() => open.current && setAdding(null))
  }

  if (page.kind === 'custom') {
    return (
      <MobileMcpCustomServerPage
        client={props.client}
        hostName={props.hostName}
        taken={taken}
        preset={page.preset}
        online={props.online}
        onCancel={() => setPage({ kind: 'catalog' })}
        onAdded={(server) => open.current && props.onOpen(server)}
      />
    )
  }
  if (page.kind === 'filter') {
    const choice = (value: McpServerCatalogCategory | null, label: string) => (
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
          title={t('mcpServers.filter', 'Filter')}
          trailing={{
            label: t('common.done', 'Done'),
            onPress: () => setPage({ kind: 'catalog' })
          }}
        />
        <SettingsSection first radioGroup>
          {choice(null, t('mcpServers.allApps', 'All apps'))}
          {categories.map((category) => choice(category, categoryLabel[category]))}
        </SettingsSection>
      </>
    )
  }
  const addedValue = t('mcpServers.added', 'Added')
  return (
    <>
      <SheetHeader
        title={t('mcpServers.addTitle', 'Add an MCP server')}
        subtitle={props.hostName}
        leadingButton={
          <NavBarButton
            icon={X}
            accessibilityLabel={t('common.close', 'Close')}
            onPress={props.onClose}
          />
        }
      />
      <SettingsSection first separatorInset={LIST_LEADING_INSET}>
        <ListRow
          title={t('mcpServers.customServer', 'Custom server')}
          subtitle={t('mcpServers.customServerLine', 'URL, command or pasted config')}
          leading={<Plus size={18} color={colors.textMuted} />}
          navigates
          disabled={!props.online || adding !== null}
          onPress={() => setPage({ kind: 'custom' })}
        />
      </SettingsSection>
      {shown.length === 0 ? (
        <MobileNoMatchState
          message={t('mcpServers.noMatch', 'No app matches “{{query}}”.', { query: query.trim() })}
        />
      ) : (
        <SettingsSection
          title={t('mcpServers.apps', 'Apps')}
          separatorInset={LIST_LEADING_INSET}
          footer={error ? <SettingsNote error>{error}</SettingsNote> : undefined}
        >
          {shown.map((entry) => {
            const added = onHost(entry) !== undefined
            return (
              <ListRow
                key={entry.id}
                leading={<McpAppLogo slug={entry.id} />}
                title={entry.name}
                subtitle={botMcpAppLine(entry, t)}
                subtitleLines={1}
                value={added ? addedValue : undefined}
                navigates
                busy={adding === entry.id}
                disabled={!props.online && !added}
                onPress={() => pick(entry)}
              />
            )
          })}
        </SettingsSection>
      )}
      <View style={{ height: barHeight }} />
    </>
  )
}
