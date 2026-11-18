import { ActivityIndicator, Text, View } from 'react-native'
import { AgentStateDot } from '../agents/presentation/AgentStateDot'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import type { SheetActivity, SheetActivityRow } from './bot-sheet-operations'
import { activityRowView, workersHeading } from './mobile-bot-sheet-copy'
import { workingWorkerRowCount } from '../../../src/shared/bots/bot-activity-recorded-workers'
import { MobileBotTextButton } from './MobileBotTextButton'
import { sheetStyles } from './mobile-bot-sheet-styles'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { MobileBotUpNext, type UpNextActions } from './MobileBotUpNext'
import { MobileBotChatTree, type BotChatTreeActions } from './MobileBotChatTree'
import type { PhoneBotChatTree } from './use-phone-bot-chat-tree'

function ActivityRow({ row }: { row: SheetActivityRow }) {
  const view = activityRowView(row)
  return (
    <ListRow
      title={view.title}
      subtitle={view.detail || undefined}
      leading={<AgentStateDot state={view.dot} />}
    />
  )
}

function ActivitySection({ title, rows }: { title: string; rows: readonly SheetActivityRow[] }) {
  if (rows.length === 0) {
    return null
  }
  return (
    <View>
      <SectionHeader title={title} />
      <ListGroup>
        {rows.map((row) => (
          <ActivityRow key={row.key} row={row} />
        ))}
      </ListGroup>
    </View>
  )
}

/** The desktop's Activity panel: Up next, then the bot's chats with their workers; an older host
 *  without the chats tree lists running workers, then in-progress and completed threads and runs. */
export function MobileBotActivityTab({
  bot,
  hostKey,
  activity,
  tree,
  treeActions,
  upNextActions,
  loading = false,
  error = false,
  onRetry,
  withoutUpNext = false
}: {
  bot: { id: string; name: string }
  hostKey: string
  activity: SheetActivity | null
  tree: PhoneBotChatTree
  treeActions: BotChatTreeActions
  upNextActions: UpNextActions
  loading?: boolean
  error?: boolean
  onRetry?: () => void
  /** The bot panel shows Up next at the end of Items instead, as the desktop does. */
  withoutUpNext?: boolean
}) {
  const botName = bot.name
  const t = useMobileTranslation()
  if (!activity) {
    return (
      <View>
        <Text style={sheetStyles.empty}>
          {error
            ? t('bots.activity.readFailed', 'Couldn’t load activity.')
            : loading
              ? t('bots.activity.loading', 'Loading activity…')
              : t('bots.activity.unavailable', 'Activity is unavailable on this host.')}
        </Text>
        {error && onRetry ? (
          <MobileBotTextButton label={t('bots.activity.retry', 'Retry')} onPress={onRetry} />
        ) : null}
      </View>
    )
  }
  const { workers, inProgress, completed, upNext } = activity
  const upNextSection =
    upNext && !withoutUpNext ? (
      <MobileBotUpNext botName={botName} upNext={upNext} actions={upNextActions} />
    ) : null
  if (tree.kind === 'loading') {
    return (
      <>
        {upNextSection}
        <ActivityIndicator style={styles.loading} color={colors.textMuted} />
      </>
    )
  }
  if (tree.kind === 'tree') {
    return (
      <>
        {upNextSection}
        <MobileBotChatTree
          bot={bot}
          hostKey={hostKey}
          chats={tree.chats}
          loadMore={tree.loadMore}
          search={tree.search}
          actions={treeActions}
        />
      </>
    )
  }
  if (workers.length + inProgress.length + completed.length === 0) {
    return (
      <>
        {upNextSection}
        <Text style={sheetStyles.empty}>
          {t('bots.activity.empty', '{{name}}’s workers, threads and runs show up here.', {
            name: botName
          })}
        </Text>
      </>
    )
  }
  return (
    <>
      {upNextSection}
      <ActivitySection title={workersHeading(workingWorkerRowCount(workers))} rows={workers} />
      <ActivitySection title={t('bots.activity.inProgress', 'In progress')} rows={inProgress} />
      <ActivitySection title={t('bots.activity.completed', 'Completed')} rows={completed} />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  loading: { paddingTop: spacing.xl }
}))
