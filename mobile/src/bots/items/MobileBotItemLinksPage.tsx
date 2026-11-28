import { useMemo, useRef, useState } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'
import type { BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import type { BotItemLinkRow } from '../../../../src/shared/bots/bot-item-link-rows'
import {
  BOT_ITEM_LINK_KINDS,
  botItemLinkSearch,
  botItemLinkSearchIndex,
  type BotItemLinkFilter
} from '../../../../src/shared/bots/bot-item-link-search'
import {
  MobileSegmentedControl,
  type MobileSegment
} from '../../components/controls/MobileSegmentedControl'
import { MobileSearchField } from '../../components/controls/MobileSearchField'
import { ListRow, LIST_LEADING_INSET } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import {
  botItemLinkSearchWords,
  MobileBotItemLinkRow,
  type BotItemLinkPress
} from './MobileBotItemLinkRow'

export function MobileBotItemLinksPage({
  rows,
  bot,
  onOpenWorker,
  onOpenFile,
  onLongPress,
  onBack
}: {
  /** The item's rows, most important first, as its Links section orders them. */
  rows: readonly BotItemLinkRow[]
  bot: { id: string; name: string }
  onOpenWorker: (worker: BotChatTreeWorker) => void
  onOpenFile: (path: string) => void
  onLongPress: (press: BotItemLinkPress) => void
  onBack: () => void
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<BotItemLinkFilter>('all')
  const list = useRef<FlatList<BotItemLinkRow>>(null)
  const index = useMemo(
    () => botItemLinkSearchIndex(rows, (row) => botItemLinkSearchWords(row, t)),
    [rows, t]
  )
  const activeFilter = index.counts[filter] ? filter : 'all'
  const result = useMemo(
    () => botItemLinkSearch(index, query, activeFilter),
    [index, query, activeFilter]
  )
  const labels: Record<BotItemLinkFilter, string> = {
    all: t('bots.share.all', 'All'),
    workers: t('agents.filterSheet.workers', 'Workers'),
    prs: t('tasks.providerViewProjection.pullRequests', 'PRs'),
    files: t('bots.panel.files', 'Files')
  }
  const segments: MobileSegment<BotItemLinkFilter>[] = (['all', ...BOT_ITEM_LINK_KINDS] as const)
    .filter((kind) => kind === 'all' || index.counts[kind] > 0)
    .map((kind) => ({
      value: kind,
      label: labels[kind],
      accessibilityLabel: `${labels[kind]} ${result.counts[kind]}`,
      trailing: <Text style={styles.count}>{result.counts[kind]}</Text>
    }))
  const scrollToStart = () => list.current?.scrollToOffset({ offset: 0, animated: false })
  return (
    <View style={styles.page}>
      <SheetHeader
        title={t('bots.items.view.links', 'Links')}
        subtitle={String(result.rows.length)}
        onBack={{
          label: t('bots.panel.backTo', 'Back to {{name}}', {
            name: t('bots.items.view.title', 'Item')
          }),
          onPress: onBack,
          size: 44
        }}
      />
      <View style={styles.controls}>
        <MobileSearchField
          value={query}
          onChangeText={(text) => {
            scrollToStart()
            setQuery(text)
          }}
          placeholder={t('hostScreen.hostBottomBar.search', 'Search')}
        />
        <MobileSegmentedControl
          segments={segments}
          selected={activeFilter}
          onSelect={(next) => {
            scrollToStart()
            setFilter(next)
          }}
          onSheet
          scrollWhenCrowded
          tabs
          largeTargets
        />
      </View>
      <FlatList
        ref={list}
        data={result.rows}
        keyExtractor={(row) => row.key}
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={<ListRow title={t('common.noMatch.title', 'No matches')} />}
        renderItem={({ item }) => (
          <MobileBotItemLinkRow
            entry={item}
            bot={bot}
            onOpenWorker={onOpenWorker}
            onOpenFile={onOpenFile}
            onLongPress={onLongPress}
          />
        )}
      />
    </View>
  )
}

function Separator() {
  const styles = useThemedStyles(stylesSheet)
  return <View style={styles.separator} />
}

const stylesSheet = themedStyleSheet((colors) => ({
  page: { flex: 1, backgroundColor: colors.sheetSurface },
  controls: { gap: spacing.sm, paddingBottom: spacing.sm },
  // One card, as the item page draws its rows; it shrinks to a short list and scrolls a long one.
  list: {
    flexGrow: 0,
    flexShrink: 1,
    borderRadius: radii.surface,
    overflow: 'hidden',
    backgroundColor: colors.sheetGroup,
    marginBottom: spacing.lg
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: LIST_LEADING_INSET
  },
  count: { fontSize: 13, color: colors.textMuted, fontVariant: ['tabular-nums'] }
}))
