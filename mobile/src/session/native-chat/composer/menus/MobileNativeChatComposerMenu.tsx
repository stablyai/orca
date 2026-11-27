import { MobileNativeChatComposerMenuReservation } from '../field/MobileNativeChatComposerAllocation'
import type { RefObject } from 'react'
import { MobileNativeChatComposerMenuLayer } from './MobileNativeChatComposerMenuLayer'
import { Pressable, ScrollView, StyleSheet, Text, View, type HostInstance } from 'react-native'
import { AtSign, FileText, Folder, Package, Terminal } from 'lucide-react-native'
import type { NativeChatPickerItem } from '../../../../../../src/shared/native-chat/input/composer/native-chat-picker-items'
import { isFolderPath } from '../../../../../../src/shared/quick-open/quick-open-folder-paths'
import { colors, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { COMPOSER_MENU_MAX_HEIGHT } from './mobile-native-chat-composer-menu-size'
import type { BotChatRow } from '../../../../../../src/shared/bots/bot-chat-row'
import type { MentionBot } from './use-mobile-native-chat-mention-bots'
import { MobileNativeChatComposerBotRow } from './MobileNativeChatComposerBotRows'

/** A room member `@` names instead of a file, e.g. a bot in a group. */
export type ComposerRoomMention = { name: string; icon?: React.ReactNode }

export type ComposerMenuRow =
  | NativeChatPickerItem
  | { kind: 'file'; id: string; path: string }
  | { kind: 'member'; id: string; name: string; icon?: React.ReactNode }
  | MentionBotRow

/** The chat's host's bots under `@`, and one level down a bot's chats. */
export type MentionBotRow =
  | { kind: 'bot'; id: string; bot: MentionBot; chats: boolean }
  | { kind: 'bot-back'; id: string; bot: MentionBot }
  | { kind: 'bot-chat'; id: string; bot: MentionBot; chat: BotChatRow }
  | {
      kind: 'bot-chats-state'
      id: string
      bot: MentionBot
      state: 'loading' | 'error' | 'none' | 'no-match'
    }

export function isMentionBotRow(row: ComposerMenuRow): row is MentionBotRow {
  return (
    row.kind === 'bot' ||
    row.kind === 'bot-back' ||
    row.kind === 'bot-chat' ||
    row.kind === 'bot-chats-state'
  )
}

const HEADINGS: Partial<Record<ComposerMenuRow['kind'], string>> = {
  command: 'Commands',
  skill: 'Skills',
  file: 'Files',
  member: 'Bots',
  bot: 'Bots'
}

export function MobileNativeChatComposerSuggestions({
  anchorRef,
  ...props
}: {
  anchorRef: RefObject<HostInstance | null>
  rows: readonly ComposerMenuRow[]
  onPick: (row: ComposerMenuRow) => void
  onOpenBotChats?: (row: Extract<ComposerMenuRow, { kind: 'bot' }>) => void
  nestedScrollEnabled?: boolean
}) {
  return (
    <>
      <MobileNativeChatComposerMenuReservation />
      {props.rows.length > 0 ? (
        <MobileNativeChatComposerMenuLayer anchorRef={anchorRef}>
          <MobileNativeChatComposerMenu {...props} />
        </MobileNativeChatComposerMenuLayer>
      ) : null}
    </>
  )
}

export function MobileNativeChatComposerMenu({
  rows,
  onPick,
  onOpenBotChats,
  nestedScrollEnabled
}: {
  rows: readonly ComposerMenuRow[]
  onPick: (row: ComposerMenuRow) => void
  onOpenBotChats?: (row: Extract<ComposerMenuRow, { kind: 'bot' }>) => void
  nestedScrollEnabled?: boolean
}): React.JSX.Element {
  useMobileColorScheme()
  return (
    <View testID="native-chat-composer-menu-card" style={styles.card}>
      <ScrollView
        keyboardShouldPersistTaps="always"
        nestedScrollEnabled={nestedScrollEnabled}
        style={styles.scroll}
      >
        {rows.map((row, index) => {
          const heading = rows[index - 1]?.kind !== row.kind ? HEADINGS[row.kind] : undefined
          return (
            <View key={row.id}>
              {heading ? <Text style={styles.heading}>{heading}</Text> : null}
              {isMentionBotRow(row) ? (
                <MobileNativeChatComposerBotRow
                  row={row}
                  onPick={onPick}
                  onOpenChats={onOpenBotChats}
                />
              ) : (
                <MenuRow row={row} onPick={onPick} />
              )}
            </View>
          )
        })}
      </ScrollView>
    </View>
  )
}

function MenuRow({
  row,
  onPick
}: {
  row: Exclude<ComposerMenuRow, MentionBotRow>
  onPick: (row: ComposerMenuRow) => void
}): React.JSX.Element {
  useMobileColorScheme()
  const Icon =
    row.kind === 'skill'
      ? Package
      : row.kind === 'command'
        ? Terminal
        : row.kind === 'member'
          ? AtSign
          : isFolderPath(row.path)
            ? Folder
            : FileText
  const description = row.kind === 'file' || row.kind === 'member' ? null : row.description
  const label = row.kind === 'file' ? row.path : row.kind === 'member' ? row.name : row.token
  const member = row.kind === 'member'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        row.kind === 'skill' && row.location ? `${row.token}, ${row.location}` : label
      }
      style={({ pressed }) => [
        styles.row,
        member && styles.memberRow,
        pressed && styles.rowPressed
      ]}
      onPress={() => onPick(row)}
    >
      {row.kind === 'member' && row.icon ? (
        row.icon
      ) : (
        <Icon size={16} color={colors.textSecondary} strokeWidth={2} style={styles.icon} />
      )}
      <View style={styles.body}>
        <View style={styles.nameLine}>
          <Text style={[styles.name, member ? styles.memberName : styles.code]} numberOfLines={1}>
            {label}
          </Text>
          {row.kind !== 'file' && row.kind !== 'member' && row.argumentHint ? (
            <Text style={styles.hint} numberOfLines={1}>
              {row.argumentHint}
            </Text>
          ) : null}
        </View>
        {description ? (
          <Text style={styles.description} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
        {row.kind === 'skill' && row.location ? (
          <Text style={styles.description}>{row.location}</Text>
        ) : null}
      </View>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    flexShrink: 1,
    marginHorizontal: 10,
    marginBottom: spacing.sm,
    paddingVertical: 6,
    borderRadius: radii.floating,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder,
    backgroundColor: colors.chatPanel,
    overflow: 'hidden'
  },
  scroll: {
    maxHeight: COMPOSER_MENU_MAX_HEIGHT
  },
  heading: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs
  },
  row: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minHeight: 44
  },
  // A room member reads like the agent chat's `@` bot rows: a face and its name, not code.
  memberRow: {
    alignItems: 'center'
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  icon: {
    marginTop: 2
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  nameLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6
  },
  name: {
    flexShrink: 1,
    color: colors.textPrimary
  },
  code: {
    fontFamily: typography.monoFamily,
    fontSize: 13.5
  },
  memberName: {
    fontSize: 14
  },
  hint: {
    flexShrink: 1,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  description: {
    color: colors.textMuted,
    fontSize: 12.5,
    lineHeight: 17
  }
}))
