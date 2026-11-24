// The pieces every phone Google setup card shares: its frame, the receipt under an answer, the
// numbered notes, the line that points to the computer, and the answer call.
import { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Laptop } from 'lucide-react-native'
import type { GoogleSetupBlocker } from '../../../../../../src/shared/google/google-setup-blocker'
import type {
  GoogleSetupCard,
  GoogleSetupRun
} from '../../../../../../src/shared/google/google-setup-run'
import { errorMessage } from '../../../../../../src/shared/errors/error-message'
import { MobileConnectorLogo } from '../../../../bots/MobileConnectorSourceIcon'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, pressedStyle, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileBotCardFrame, MobileBotCardMeta } from './MobileBotCardFrame'
import { answerMobileGoogleSetup } from './mobile-google-setup-store'

/** What a setup card acts on: the chat's host, the bot, and its run as last read. */
export type MobileGoogleSetupScope = {
  client: RpcClient | null
  hostKey: string
  botId: string
  botName: string
  run: GoogleSetupRun
  blocker: GoogleSetupBlocker | null
  fontScale: number
}

/** Records an answer, with the card's busy state and the host's refusal to show. A choice card
 *  reopened with Change folds back once its new answer lands. */
export function useMobileGoogleSetupAnswer(scope: MobileGoogleSetupScope): {
  busy: boolean
  error: string | null
  reopened: boolean
  reopen: () => void
  answer: (card: GoogleSetupCard, values: string[]) => Promise<void>
  run: (work: () => Promise<void>) => Promise<boolean>
} {
  const [busy, setBusy] = useState(false)
  const [reopened, setReopened] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await work()
      return true
    } catch (caught) {
      setError(errorMessage(caught))
      return false
    } finally {
      setBusy(false)
    }
  }
  const { client, hostKey, botId } = scope
  const answer = async (card: GoogleSetupCard, values: string[]): Promise<void> => {
    const ok = await run(async () => {
      if (client) {
        await answerMobileGoogleSetup(client, hostKey, botId, card, values)
      }
    })
    if (ok) {
      setReopened(false)
    }
  }
  return { busy, error, reopened, reopen: () => setReopened(true), answer, run }
}

/** Also the Composio setup cards' frame, as on the desktop; `avatar` replaces the Google mark. */
export function MobileGoogleSetupFrame({
  avatar,
  heading,
  trailing,
  trailingTone,
  title,
  titleLines,
  meta,
  fontScale,
  children
}: {
  avatar?: ReactNode
  heading: string
  trailing?: string | null
  /** `ask` when it waits on the owner. */
  trailingTone?: 'ask'
  title?: string
  titleLines?: number
  meta?: string | null
  fontScale: number
  children?: ReactNode
}): React.JSX.Element {
  return (
    <MobileBotCardFrame
      avatar={avatar ?? <MobileConnectorLogo source="google" />}
      heading={heading}
      trailing={
        trailing ? (
          <Text
            style={[
              styles.trailing,
              trailingTone === 'ask' && styles.trailingAsk,
              scaledType(typography.metaSize, fontScale, 4)
            ]}
          >
            {trailing}
          </Text>
        ) : null
      }
      {...(title ? { title, titleLines } : {})}
      meta={
        meta ? (
          <MobileBotCardMeta fontScale={fontScale} lines={3}>
            {meta}
          </MobileBotCardMeta>
        ) : null
      }
      fontScale={fontScale}
    >
      {children}
    </MobileBotCardFrame>
  )
}

/** The line under an answered card, in place of a chat bubble: what was chosen, and Change. */
export function MobileGoogleSetupReceipt({
  text,
  onChange,
  fontScale
}: {
  text: string
  onChange?: () => void
  fontScale: number
}): React.JSX.Element {
  const t = useMobileTranslation()
  return (
    <View style={styles.receipt}>
      <Text style={[styles.receiptText, scaledType(typography.metaSize, fontScale)]}>{text}</Text>
      {onChange ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={12}
          onPress={onChange}
          style={({ pressed }) => pressed && pressedStyle}
        >
          <Text style={[styles.link, scaledType(typography.metaSize, fontScale)]}>
            {t('chat.botCards.google.receipt.change', 'Change')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** A line with its key words in <b>, as the computer's notes are written. */
function BoldMarked({ text, style }: { text: string; style: object[] }): React.JSX.Element {
  // Split on the tags, so every odd piece sat between <b> and </b>; a rising start keys each.
  const pieces = text
    .split(/<\/?b>/)
    .reduce<{ text: string; bold: boolean; at: number }[]>((all, piece, index) => {
      const last = all.at(-1)
      all.push({
        text: piece,
        bold: index % 2 === 1,
        at: last ? last.at + last.text.length + 3 : 0
      })
      return all
    }, [])
  return (
    <Text style={style}>
      {pieces.map((piece) =>
        piece.bold ? (
          <Text key={piece.at} style={styles.bold}>
            {piece.text}
          </Text>
        ) : (
          piece.text
        )
      )}
    </Text>
  )
}

/** What to do on a step, one numbered line each. */
export function MobileGoogleSetupNotes({
  notes,
  fontScale
}: {
  notes: readonly string[]
  fontScale: number
}): React.JSX.Element {
  return (
    <View style={styles.notes}>
      {notes.map((note, index) => (
        <View key={note} style={styles.note}>
          <Text style={[styles.noteNumber, scaledType(typography.bodySize, fontScale)]}>
            {index + 1}
          </Text>
          <BoldMarked
            text={note}
            style={[styles.noteText, scaledType(typography.bodySize, fontScale)]}
          />
        </View>
      ))}
    </View>
  )
}

/** The one line that says this part happens on the computer. */
export function MobileGoogleSetupOnComputer({
  text,
  fontScale
}: {
  text: string
  fontScale: number
}): React.JSX.Element {
  return (
    <View style={styles.onComputer}>
      <Laptop size={14} color={colors.textMuted} />
      <Text style={[styles.onComputerText, scaledType(typography.metaSize, fontScale)]}>
        {text}
      </Text>
    </View>
  )
}

export function MobileGoogleSetupMuted({
  text,
  fontScale
}: {
  text: string
  fontScale: number
}): React.JSX.Element {
  return <Text style={[styles.muted, scaledType(typography.metaSize, fontScale, 4)]}>{text}</Text>
}

export function MobileGoogleSetupError({
  text,
  fontScale
}: {
  text: string | null
  fontScale: number
}): React.JSX.Element | null {
  return text ? (
    <Text style={[styles.error, scaledType(typography.metaSize, fontScale)]}>{text}</Text>
  ) : null
}

const styles = themedStyleSheet(() => ({
  trailing: { color: colors.textMuted, marginLeft: 'auto' },
  trailingAsk: { color: colors.agentQuestion },
  muted: { color: colors.textMuted },
  receipt: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  receiptText: { flex: 1, color: colors.textSecondary },
  link: { color: colors.textPrimary, fontWeight: '600' },
  bold: { fontWeight: '600' },
  notes: { gap: 6 },
  note: { flexDirection: 'row', gap: spacing.sm },
  noteNumber: {
    width: 14,
    textAlign: 'right',
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  noteText: { flex: 1, color: colors.textPrimary },
  onComputer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: -spacing.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  onComputerText: { flex: 1, color: colors.textSecondary },
  error: { color: colors.statusRed }
}))
