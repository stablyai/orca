// The item page's comment box, docked at the bottom: it names the bot's open question, sends with the
// chat composer's arrow, and keeps its text until a send lands (closing the panel keeps each item's draft for
// the session). Offline, Comment waits; a dropped reply says the comment may have arrived, never resends.
// The chat's field and mic: the session's dictation lands here while the box is its target.
import {
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref
} from 'react'
import { Text, View, type HostInstance, type TextInputInstance } from 'react-native'
import { CornerDownRight, WifiOff } from 'lucide-react-native'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import { ComposerSendButton } from '../../components/composer-input/ComposerSendButton'
import { COMPOSER_COMPACT_CONTROL_SIZE } from '../../components/composer-input/composer-input-styles'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { triggerError } from '../../platform/haptics/haptics'
import { MobileNativeChatComposerField } from '../../session/native-chat/composer/field/MobileNativeChatComposerField'
import { MobileNativeChatComposerMic } from '../../session/native-chat/composer/dictation/MobileNativeChatComposerMic'
import { MobileNativeChatDictationLeading } from '../../session/native-chat/composer/dictation/MobileNativeChatDictationLeading'
import { useMobileNativeChatComposerDictation } from '../../session/native-chat/composer/dictation/use-mobile-native-chat-composer-dictation'
import {
  blurMobileNativeChatTextDestination,
  focusMobileNativeChatTextDestination
} from '../../session/native-chat/composer/drafts/mobile-native-chat-draft-inputs'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { commentOnBotItem } from './bot-item-operations'
import { BotItemCommentMicContext } from './bot-item-comment-mic'
import { botItemWriteFailure } from './use-bot-item-moves'

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
  const mic = useContext(BotItemCommentMicContext)
  const [text, setTextState] = useState(() => drafts.get(item.uid) ?? '')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<TextInputInstance>(null)
  const cancelRef = useRef<HostInstance>(null)
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }))
  const { uid } = item
  const setText = useCallback(
    (next: string) => {
      setTextState(next)
      setError(null)
      if (next) {
        drafts.set(uid, next)
      } else {
        drafts.delete(uid)
      }
    },
    [uid]
  )
  // A late transcript lands in this item's draft even after the box closed.
  const insertDictation = useCallback(
    (insert: (draft: string) => string) => setText(insert(drafts.get(uid) ?? '')),
    [setText, uid]
  )
  const [caret, setCaret] = useState<{ start: number; end: number } | null>(null)
  const placeCaret = useCallback((at: number) => setCaret({ start: at, end: at }), [])
  const scope = `bot-item-comment:${uid}`
  useEffect(() => () => blurMobileNativeChatTextDestination(scope), [scope])
  const dictation = useMobileNativeChatComposerDictation({
    draftScopeKey: scope,
    value: text,
    insertDictation,
    placeCaret
  })
  // The mic makes this box the dictation's target before it starts, as focusing it does.
  const target = (run: (() => void) | undefined) =>
    run &&
    (() => {
      focusMobileNativeChatTextDestination(scope)
      run()
    })
  const micActive = mic?.micActive ?? false
  const canSend = online && text.trim().length > 0 && !micActive
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
        <View style={styles.field}>
          <MobileNativeChatComposerField
            ref={input}
            value={text}
            skillToken={null}
            dictationPreview={dictation.preview}
            onChangeText={setText}
            onFocus={() => focusMobileNativeChatTextDestination(scope)}
            selection={caret ?? undefined}
            onSelectionChange={(event) => {
              dictation.readSelection(event)
              setCaret(null)
            }}
            onKeyboardSubmit={() => void send()}
            editable={!sending}
            multiline
            accessibilityLabel={t('bots.items.comment.label', 'Comment')}
            placeholder={t('bots.items.comment.add', 'Add a comment…')}
            placeholderTextColor={colors.textMuted}
            selectionColor={colors.textPrimary}
          />
        </View>
        {mic?.onMicPress ? (
          // Centred on the compact send button's row, so the two sit level.
          <View style={styles.micSlot}>
            <MobileNativeChatComposerMic
              {...mic}
              onMicPress={target(mic.onMicPress)}
              onMicPressIn={target(mic.onMicPressIn)}
              cancelRef={cancelRef}
              disabled={!online || sending}
            />
          </View>
        ) : null}
        <ComposerSendButton
          size="compact"
          onPress={() => void send()}
          canSend={canSend}
          sending={sending}
          label={t('bots.items.comment.submit', 'Comment')}
        />
      </View>
      {mic ? (
        <View style={styles.dictation}>
          <MobileNativeChatDictationLeading
            micActive={micActive}
            micStarting={mic.micStarting}
            micProcessing={mic.micProcessing}
            cancelRef={cancelRef}
            trailing={null}
          >
            {null}
          </MobileNativeChatDictationLeading>
        </View>
      ) : null}
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
  field: { flex: 1 },
  micSlot: { height: COMPOSER_COMPACT_CONTROL_SIZE, justifyContent: 'center' },
  dictation: { flexDirection: 'row', alignItems: 'center' },
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
