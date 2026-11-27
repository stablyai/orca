import { ActivityIndicator } from 'react-native'
import { Activity } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { SheetActivity } from './bot-sheet-operations'
import {
  MobileLoadErrorState,
  MobileOfflineState,
  MobileStateView
} from '../components/feedback/MobileStateView'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { MobileBotUpNext, type UpNextActions } from './MobileBotUpNext'
import { MobileBotChatTree, type BotChatTreeActions } from './MobileBotChatTree'
import type { PhoneBotChatTree } from './use-phone-bot-chat-tree'
import { useMobileColors } from '../theme/use-mobile-color-scheme'

/** The desktop's Activity panel: Up next, then the bot's chats with their workers. */
export function MobileBotActivityTab({
  bot,
  hostKey,
  activity,
  tree,
  treeActions,
  upNextActions,
  loading = false,
  error,
  onRetry,
  online,
  hostName,
  withoutUpNext = false
}: {
  bot: { id: string; name: string }
  hostKey: string
  activity: SheetActivity | null
  tree: PhoneBotChatTree
  treeActions: BotChatTreeActions
  upNextActions: UpNextActions
  loading?: boolean
  /** Null while the last read landed; why it failed otherwise. */
  error: string | null
  onRetry?: () => void
  online: boolean
  hostName: string
  /** The bot panel shows Up next at the end of Items instead, as the desktop does. */
  withoutUpNext?: boolean
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const botName = bot.name
  const t = useMobileTranslation()
  if (!activity) {
    return !online ? (
      <MobileOfflineState hostName={hostName} />
    ) : error !== null ? (
      <MobileLoadErrorState
        error={error}
        title={t('bots.activity.readFailedTitle', 'Couldn’t load activity')}
        onRetry={onRetry}
      />
    ) : loading ? (
      <MobileStateView loading title={t('bots.activity.loading', 'Loading activity…')} />
    ) : (
      <MobileStateView
        icon={Activity}
        title={t('bots.activity.unavailableTitle', 'Activity unavailable')}
        message={t('bots.activity.unavailable', 'Activity is unavailable on this host.')}
      />
    )
  }
  const { upNext } = activity
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
  return (
    <>
      {upNextSection}
      <MobileLoadErrorState
        error={null}
        title={t('bots.chats.readFailedTitle', 'Couldn’t load chats')}
        onRetry={tree.retry}
      />
    </>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  loading: { paddingTop: spacing.xl }
}))
