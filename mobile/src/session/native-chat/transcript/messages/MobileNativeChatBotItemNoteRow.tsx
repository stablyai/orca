// Item changes in a bot chat: the desktop's quiet line (its words from the shared note lines), with the
// phone's wrap: several items list one chip per line, a long lead on its own line above them. Chips open
// the item where the screen can open one; the owner's comment is their own message under the item's chip.
import { createContext, useContext, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ListTodo, MessageSquare } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { isNativeChatOrcaCard } from '../../../../../../src/shared/native-chat/native-chat-orca-card'
import { stripSentImagePromptMarkers } from '../../../../../../src/shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import {
  isBotItemMail,
  type BotItemNoteJoin
} from '../../../../../../src/shared/bots/bot-item-note-runs'
import type {
  BotItemNoteItem,
  BotItemNoteView
} from '../../../../../../src/shared/bots/bot-item-note'
import {
  botItemNoteLines,
  botItemNoteRunLine,
  type BotItemNoteLine,
  type BotItemNoteLineChat
} from '../../../../../../src/shared/bots/bot-item-note-lines'
import { botItemStatusName } from '../../../../../../src/shared/bots/bot-item-status-name'
import { BotChatOpenContext, BotItemOpenContext } from '../../../../bots/bot-item-open'
import { MobileBotItemStatusIcon } from '../../../../bots/items/MobileBotItemStatusIcon'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, pressedStyle, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { Prose } from '../message-content/MobileNativeChatProse'
import { mobileNativeChatRowId } from '../viewport/mobile-native-chat-reading-place'
import { scaledType, styles as messageStyles } from './mobile-native-chat-message-styles'

/** Chips a bulk line shows before "+N more", as on the desktop. */
const CHIPS_SHOWN = 3
/** Longer leads ("You moved 3 items to Planned:") take their own line so the chips keep their width. */
const LEAD_BESIDE_CHIPS_MAX = 16
const LINE_SIZE = 13
const LINE_HEIGHT = 27
const CHIP_SIZE = 12.5
const CHIP_HEIGHT = 22

function ItemChip({
  item,
  fontScale,
  open
}: {
  item: BotItemNoteItem
  fontScale: number
  open: ((itemUid: string) => void) | null
}): React.JSX.Element {
  const t = useMobileTranslation()
  const body = (
    <>
      <MobileBotItemStatusIcon status={item.status} />
      <Text numberOfLines={1} style={[styles.chipText, scaledType(CHIP_SIZE, fontScale, 4)]}>
        {item.title}
      </Text>
    </>
  )
  const chip = [styles.chip, { minHeight: CHIP_HEIGHT * fontScale }]
  // The glyph alone shows the status, so the chip says it.
  const label = t('bots.items.chat.chipLabel', '{{title}}, {{status}}', {
    title: item.title,
    status: botItemStatusName(item.status, t)
  })
  return open ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={t('bots.items.chat.opensInItems', 'Opens in Items')}
      onPress={() => open(item.uid)}
      style={({ pressed }) => [chip, pressed && pressedStyle]}
    >
      {body}
    </Pressable>
  ) : (
    <View accessible accessibilityLabel={label} style={chip}>
      {body}
    </View>
  )
}

/** The chat that made a change, opening that chat where the screen can. */
function ChatChip({
  chat,
  fontScale
}: {
  chat: BotItemNoteLineChat
  fontScale: number
}): React.JSX.Element {
  const t = useMobileTranslation()
  const open = useContext(BotChatOpenContext)
  const body = (
    <>
      <MessageSquare size={12 * fontScale} strokeWidth={2} color={colors.textSecondary} />
      <Text numberOfLines={1} style={[styles.chipText, scaledType(CHIP_SIZE, fontScale, 4)]}>
        {chat.name}
      </Text>
    </>
  )
  const chip = [styles.chip, { minHeight: CHIP_HEIGHT * fontScale }]
  return open ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('bots.items.chat.openChat', 'Open {{chat}}', { chat: chat.name })}
      onPress={() => open(chat)}
      style={({ pressed }) => [chip, pressed && pressedStyle]}
    >
      {body}
    </Pressable>
  ) : (
    <View accessible accessibilityLabel={chat.name} style={chip}>
      {body}
    </View>
  )
}

/** The words before the items' chips: the lead, the acting chat's chip with its words, and a linked worker. */
function Lead({
  line,
  type,
  fontScale
}: {
  line: BotItemNoteLine & { kind: 'line' }
  type: ReturnType<typeof scaledType>
  fontScale: number
}): React.JSX.Element {
  const { chat } = line
  const before = chat ? chat.after : line.lead
  const words = [before, line.link?.name, line.link?.after].filter(Boolean).join(' ')
  return (
    <>
      {chat && line.lead ? <Text style={[styles.text, type]}>{line.lead}</Text> : null}
      {chat ? <ChatChip chat={chat} fontScale={fontScale} /> : null}
      {words ? <Text style={[styles.text, type]}>{words}</Text> : null}
    </>
  )
}

/** What follows the chips ("to In progress", "done: Merged", "Planned → In progress"). */
function lineEnd(line: BotItemNoteLine & { kind: 'line' }): string {
  return [line.tail, line.detail].filter(Boolean).join(': ')
}

function leadLength({ lead, chat, link }: BotItemNoteLine & { kind: 'line' }): number {
  return (
    lead.length +
    (chat ? chat.name.length + chat.after.length + 2 : 0) +
    (link ? link.name.length + link.after.length + 2 : 0)
  )
}

function QuietLine({
  line,
  fontScale
}: {
  line: BotItemNoteLine & { kind: 'line' }
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const open = useContext(BotItemOpenContext)
  const [allChips, setAllChips] = useState(false)
  const type = scaledType(LINE_SIZE, fontScale, LINE_HEIGHT - LINE_SIZE)
  const chips = allChips ? line.items : line.items.slice(0, CHIPS_SHOWN)
  const hiddenChips = line.items.length - chips.length
  const end = lineEnd(line)
  // A detail's colon stays on the chip's line when the rest wraps.
  const glued = !line.tail && line.detail ? ':' : null
  const icon = (
    <View style={[styles.icon, { height: LINE_HEIGHT * fontScale }]}>
      <ListTodo size={14 * fontScale} strokeWidth={2} color={colors.textMuted} />
    </View>
  )
  if (line.items.length === 1) {
    return (
      <View style={styles.line}>
        {icon}
        <View style={styles.flow}>
          <Lead line={line} type={type} fontScale={fontScale} />
          <View style={styles.flowChip}>
            <ItemChip item={line.items[0]!} fontScale={fontScale} open={open} />
            {glued ? <Text style={[styles.text, styles.lead, type]}>{glued}</Text> : null}
          </View>
          {end ? <Text style={[styles.text, type]}>{end}</Text> : null}
        </View>
      </View>
    )
  }
  return (
    <View style={styles.line}>
      {icon}
      <View style={leadLength(line) > LEAD_BESIDE_CHIPS_MAX ? styles.stacked : styles.beside}>
        {line.chat || line.link ? (
          <View style={styles.flow}>
            <Lead line={line} type={type} fontScale={fontScale} />
          </View>
        ) : line.lead ? (
          <Text style={[styles.text, styles.lead, type]}>{line.lead}</Text>
        ) : null}
        <View style={styles.chips}>
          {chips.map((item) => (
            <ItemChip key={item.uid} item={item} fontScale={fontScale} open={open} />
          ))}
          {hiddenChips > 0 ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={spacing.sm}
              onPress={() => setAllChips(true)}
              style={({ pressed }) => pressed && pressedStyle}
            >
              <Text style={[styles.more, type]}>
                {t('bots.items.chat.moreItems', '+{{count}} more', { count: hiddenChips })}
              </Text>
            </Pressable>
          ) : null}
          {end ? <Text style={[styles.text, type]}>{end}</Text> : null}
        </View>
      </View>
    </View>
  )
}

function CommentLine({
  line,
  fontScale
}: {
  line: BotItemNoteLine & { kind: 'comment' }
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const open = useContext(BotItemOpenContext)
  // The comment's images go with its mail, so the [Image #N] its send wrote go, as on desktop.
  const text = stripSentImagePromptMarkers(line.text, line.images?.length ?? 0)
  return (
    <View style={[messageStyles.userBubble, styles.comment]}>
      <View style={styles.commentOn}>
        <ListTodo size={12 * fontScale} strokeWidth={2} color={colors.textMuted} />
        <Text style={[styles.text, scaledType(typography.metaSize, fontScale)]}>
          {t('bots.items.chat.commentOn', 'On')}
        </Text>
        <ItemChip item={line.item} fontScale={fontScale} open={open} />
      </View>
      <Prose block={{ type: 'text', text }} text={text} userMessage fontScale={fontScale} />
    </View>
  )
}

function noteLines(note: BotItemNoteView, t: Translate): BotItemNoteLine[] {
  return note.run ? [botItemNoteRunLine(note.run, t)] : botItemNoteLines(note, t)
}

/** The sides where a row's item note touches another, set where rows are laid out. */
export const MobileNativeChatItemNoteJoinContext = createContext<BotItemNoteJoin | undefined>(
  undefined
)

export function MobileNativeChatBotItemNoteRow({
  note,
  rowId,
  fontScale
}: {
  note: BotItemNoteView
  rowId: string
  fontScale: number
}): React.JSX.Element {
  const t = useMobileTranslation()
  // 1 + 1 pt where two touch, so their lines sit 2 pt apart, as inside one note.
  const join = useContext(MobileNativeChatItemNoteJoinContext)
  const edges = {
    ...(join === 'above' || join === 'both' ? { paddingTop: spacing.xxs / 2 } : {}),
    ...(join === 'below' || join === 'both' ? { paddingBottom: spacing.xxs / 2 } : {})
  }
  return (
    <View style={[styles.row, edges]} testID={mobileNativeChatRowId(rowId)}>
      {noteLines(note, t).map((line) =>
        line.kind === 'comment' ? (
          <CommentLine key={`comment:${line.item.uid}`} line={line} fontScale={fontScale} />
        ) : (
          <QuietLine key={`line:${line.items[0]!.uid}`} line={line} fontScale={fontScale} />
        )
      )}
    </View>
  )
}

/** A note's row; an empty one for item mail (its note shows the change) and a note folded into another,
 *  as on the desktop; null for any other message. */
export function mobileNativeChatBotItemRow(
  message: NativeChatMessage,
  rowId: string,
  fontScale: number
): React.JSX.Element | null {
  if (message.botItemNote) {
    return (
      <MobileNativeChatBotItemNoteRow
        note={message.botItemNote}
        rowId={rowId}
        fontScale={fontScale}
      />
    )
  }
  const folded =
    message.role === 'system' && message.blocks.length === 0 && !isNativeChatOrcaCard(message)
  return isBotItemMail(message) || folded ? <View testID={mobileNativeChatRowId(rowId)} /> : null
}

const styles = themedStyleSheet(() => ({
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    gap: spacing.xxs
  },
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm
  },
  icon: {
    justifyContent: 'center'
  },
  // One item: the lead, its chip and the rest flow as one sentence.
  flow: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing.xs
  },
  flowChip: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '100%',
    flexShrink: 1
  },
  beside: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs
  },
  stacked: {
    flex: 1,
    minWidth: 0
  },
  lead: {
    flexShrink: 0
  },
  chips: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-start',
    paddingVertical: 2.5,
    gap: 5
  },
  text: {
    color: colors.textMuted,
    flexShrink: 1
  },
  more: {
    color: colors.textSecondary
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: '100%',
    flexShrink: 1,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised
  },
  chipText: {
    flexShrink: 1,
    color: colors.textSecondary
  },
  comment: {
    alignSelf: 'flex-end',
    gap: spacing.xs
  },
  commentOn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  }
}))
