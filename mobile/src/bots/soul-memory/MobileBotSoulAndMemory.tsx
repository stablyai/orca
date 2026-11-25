// Settings › Soul and Settings › Memory: SOUL.md read as the desktop's Read view shows it, and MEMORY.md
// as the desktop's Memory panel.
import { useState, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import { MessageSquareText } from '../../components/icons/app-icons'
import type { BotMemoryFact } from '../../../../src/shared/bot-memory-lines'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { ListGroup, ListRow, SectionHeader } from '../../components/list/ListGroup'
import { MobileMarkdown } from '../../components/markdown/MobileMarkdown'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { isHostNotConnectedError } from '../../query/host-query-errors'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { MobileBotMemoryBody, MobileBotMemoryEditPage, type MemoryActions } from './MobileBotMemory'
import { useBotHomeFile, useBotMemoryTopics, type BotHomeFileRead } from './use-bot-home-files'

// File names, never translated.
const SOUL_FILE = 'SOUL.md'
const MEMORY_FILE = 'MEMORY.md'

/** What the Soul and Memory pages read and change: the bot's home on its host. */
export type SoulAndMemoryPageProps = {
  client: RpcClient | null
  bot: { id: string; folderWorkspaceId: string }
  /** The route's read count: the files read again with it. */
  reads: number
  showToast: (message: string, durationMs?: number) => void
  online: boolean
  hostName: string
  banner: ReactNode
  onBack: () => void
}

/** A home file's loading, offline and error states; its text once read. */
function HomeFileBody(props: {
  read: BotHomeFileRead
  name: string
  hostName: string
  onRetry: () => void
  children: (text: string) => ReactNode
}) {
  const t = useMobileTranslation()
  const { read, name } = props
  if (read.status === 'ready') {
    return props.children(read.text)
  }
  if (read.status === 'offline') {
    return (
      <SettingsNote>
        {t('bots.homeFile.offline', '{{file}} opens once {{host}} is back.', {
          file: name,
          host: props.hostName
        })}
      </SettingsNote>
    )
  }
  if (read.status === 'failed') {
    return (
      <MobileStateView
        title={read.error || t('bots.errors.generic', 'Something went wrong. Try again.')}
        action={{ label: t('bots.homeFile.retry', 'Retry'), onPress: props.onRetry }}
      />
    )
  }
  return (
    <MobileStateView
      loading
      title={t('bots.homeFile.reading', 'Reading {{file}}…', { file: name })}
    />
  )
}

/** SOUL.md as the desktop's Read view shows it; phones can't write files, so Change in chat asks the bot. */
export function MobileBotSoulPage(
  props: SoulAndMemoryPageProps & { onAskInChat: ((draft: string) => void) | null }
) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const soul = useBotHomeFile(props.client, props.bot.folderWorkspaceId, SOUL_FILE, props.reads)
  const onAskInChat = props.onAskInChat
  return (
    <>
      <SheetHeader
        title={t('bots.soul.title', 'Soul')}
        onBack={{ label: t('bots.lookAround.back', 'Back to Settings'), onPress: props.onBack }}
      />
      {props.banner}
      <HomeFileBody
        read={soul.read}
        name={SOUL_FILE}
        hostName={props.hostName}
        onRetry={soul.refresh}
      >
        {(text) => {
          const lines = text ? text.split('\n').length : 0
          const words = text.trim() ? text.trim().split(/\s+/).length : 0
          return (
            <>
              <SectionHeader
                title={SOUL_FILE}
                trailing={t('bots.soul.stats', '{{lines}} lines · {{words}} words', {
                  lines,
                  words
                })}
              />
              <ListGroup>
                <View style={styles.document}>
                  {text.trim() ? (
                    <MobileMarkdown content={text} />
                  ) : (
                    <Text style={styles.empty}>{t('bots.soul.empty', 'No instructions yet.')}</Text>
                  )}
                </View>
              </ListGroup>
              {onAskInChat ? (
                <SettingsSection>
                  <ListRow
                    leading={
                      <MessageSquareText size={18} color={colors.textPrimary} strokeWidth={2} />
                    }
                    title={t('bots.soul.changeInChat', 'Change in chat')}
                    accessibilityRole="button"
                    onPress={() =>
                      onAskInChat(t('bots.soul.changeDraft', 'Change your SOUL.md so that '))
                    }
                  />
                </SettingsSection>
              ) : null}
            </>
          )
        }}
      </HomeFileBody>
    </>
  )
}

/** The desktop's Memory panel: What it knows and History. */
export function MobileBotMemoryPage(
  props: SoulAndMemoryPageProps & {
    /** memory/'s files as Settings listed them. */
    topicNames: readonly string[] | null
    /** Opens a file in the bot's folder in the file viewer; null where there is none. */
    onOpenFile: ((path: string) => void) | null
  }
) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { client, bot } = props
  const memory = useBotHomeFile(client, bot.folderWorkspaceId, MEMORY_FILE, props.reads)
  const topics = useBotMemoryTopics(client, bot.folderWorkspaceId, props.topicNames)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<BotMemoryFact | null>(null)
  const [quickAdd, setQuickAdd] = useState('')
  // Settings' own Back closes the page; this one closes the open fact first.
  useBackClaim(
    editing
      ? () => {
          setEditing(null)
          return true
        }
      : null
  )
  const actions: MemoryActions = {
    busy,
    showToast: (message) => props.showToast(message, 2400),
    run: async (change) => {
      if (!client) {
        return false
      }
      setBusy(true)
      try {
        await change(client)
        return true
      } catch (error) {
        props.showToast(
          isHostNotConnectedError(error)
            ? t('bots.items.write.offline', '{{host}} is offline.', { host: props.hostName })
            : error instanceof Error && error.message
              ? error.message
              : t('bots.errors.generic', 'Something went wrong. Try again.'),
          1800
        )
        return false
      } finally {
        setBusy(false)
        memory.refresh()
      }
    }
  }
  const disabled = !props.online
  if (editing && memory.read.status === 'ready') {
    return (
      <MobileBotMemoryEditPage
        botId={bot.id}
        fact={editing}
        text={memory.read.text}
        disabled={disabled}
        actions={actions}
        onClose={() => setEditing(null)}
      />
    )
  }
  return (
    <>
      <SheetHeader
        title={t('bots.memory.title', 'Memory')}
        onBack={{ label: t('bots.lookAround.back', 'Back to Settings'), onPress: props.onBack }}
      />
      {props.banner}
      <HomeFileBody
        read={memory.read}
        name={MEMORY_FILE}
        hostName={props.hostName}
        onRetry={memory.refresh}
      >
        {(text) => (
          <MobileBotMemoryBody
            client={client}
            botId={bot.id}
            text={text}
            topics={topics}
            disabled={disabled}
            actions={actions}
            onOpenFile={props.onOpenFile}
            onEdit={setEditing}
            quickAdd={quickAdd}
            setQuickAdd={setQuickAdd}
          />
        )}
      </HomeFileBody>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  document: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  empty: { fontSize: 15, color: colors.textSecondary }
}))
