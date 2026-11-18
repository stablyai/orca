// The item page's comment box, docked at the bottom: it names the bot's open question, sends with the
// chat composer's arrow, and keeps its text until a send lands (closing the panel keeps each item's draft for
// the session). Offline, Comment waits; a dropped reply says the comment may have arrived, never resends.
import { useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Text, TextInput, View, type TextInputInstance } from 'react-native'
import { CornerDownRight, WifiOff } from 'lucide-react-native'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import { ComposerSendButton } from '../../components/composer-input/ComposerSendButton'
import { COMPOSER_COMPACT_CONTROL_SIZE } from '../../components/composer-input/composer-input-styles'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { triggerError } from '../../platform/haptics/haptics'
import { useTextInputContentHeight } from '../../platform/text-input/text-input-content-height'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { commentOnBotItem } from './bot-item-operations'
import { botItemWriteFailure } from './use-bot-item-moves'

const INPUT_MAX_HEIGHT = 132

// Each item's unsent text, for this app session.
const drafts = new Map<string, string>()

export type BotItemCommentBoxHandle = { focus: () => void }

export function MobileBotItemCommentBox({
  client,
  item,
  online,
  hostName,
  ref
}: {
  client: RpcClient | null
  item: BotItem
  online: boolean
  hostName: string
  ref?: Ref<BotItemCommentBoxHandle>
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [text, setTextState] = useState(() => drafts.get(item.uid) ?? '')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<TextInputInstance>(null)
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }))
  const contentHeight = useTextInputContentHeight(input, text)
  const setText = (next: string) => {
    setTextState(next)
    setError(null)
    if (next) {
      drafts.set(item.uid, next)
    } else {
      drafts.delete(item.uid)
    }
  }
  const canSend = online && text.trim().length > 0
  const send = async () => {
    if (!canSend || sending || !client) {
      return
    }
    setSending(true)
    const outcome = await commentOnBotItem(client, item.uid, text.trim())
    setSending(false)
    if (outcome.kind === 'done') {
      setText('')
      return
    }
    triggerError()
    setError(botItemWriteFailure(outcome, hostName, t))
  }
  const notice = !online
    ? t(
        'bots.items.comment.offline',
        '{{host}} is offline. Your comment is kept; Comment works again when it’s back.',
        { host: hostName }
      )
    : null
  return (
    <View style={styles.box}>
      {item.question ? (
        <View style={styles.answering}>
          <CornerDownRight size={12} color={colors.textMuted} />
          <Text style={styles.answeringText} numberOfLines={1}>
            {t('bots.items.comment.answering', 'Answering:')}{' '}
            <Text style={styles.answeringQuestion}>{item.question.text}</Text>
          </Text>
        </View>
      ) : null}
      <View style={styles.row}>
        <TextInput
          ref={input}
          value={text}
          onChangeText={setText}
          editable={!sending}
          multiline
          accessibilityLabel={t('bots.items.comment.label', 'Comment')}
          placeholder={t('bots.items.comment.add', 'Add a comment…')}
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.textPrimary}
          style={[
            styles.input,
            // A web textarea opens two rows tall; it takes its text's height, as the chat composer's does.
            contentHeight !== undefined && {
              height: Math.min(
                INPUT_MAX_HEIGHT,
                Math.max(COMPOSER_COMPACT_CONTROL_SIZE, contentHeight)
              )
            },
            sending && styles.inputSending
          ]}
        />
        <ComposerSendButton
          size="compact"
          onPress={() => void send()}
          canSend={canSend}
          sending={sending}
          label={t('bots.items.comment.submit', 'Comment')}
        />
      </View>
      {error || notice ? (
        <View style={styles.notice}>
          {notice && !error ? <WifiOff size={12} color={colors.textSecondary} /> : null}
          <Text style={[styles.noticeText, error ? styles.errorText : null]}>
            {error ?? notice}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  box: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderRadius: radii.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.sheetGroup
  },
  answering: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs
  },
  answeringText: { flex: 1, fontSize: typography.metaSize, color: colors.textMuted },
  answeringQuestion: { fontWeight: '500', color: colors.textSecondary },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex: 1,
    minHeight: COMPOSER_COMPACT_CONTROL_SIZE,
    maxHeight: INPUT_MAX_HEIGHT,
    paddingVertical: spacing.xs,
    fontSize: 15,
    lineHeight: 20,
    color: colors.textPrimary
  },
  inputSending: { color: colors.textSecondary },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  noticeText: {
    flex: 1,
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    lineHeight: 16
  },
  errorText: { color: colors.statusRed }
}))
