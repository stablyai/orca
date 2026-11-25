// The item page's comment box, docked at the bottom: it sends with the chat composer's arrow, and a sent
// comment shows in Activity at once while it goes (one that fails stays there with Retry). Closing the
// panel keeps each item's draft, photos too, for the session. Offline, Comment waits. While the agent's
// question waits, "Replying to" names it, as on the desktop; its × sends the comment as one of its own.
// The chat's field and mic: the session's dictation lands here while the box is its target. Photos
// attach with the chat's + and thumbnails, each named [Image #N] in the words.
import { useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react'
import { Pressable, Text, View, type HostInstance, type TextInputInstance } from 'react-native'
import { WifiOff, X } from 'lucide-react-native'
import type { BotItem, BotItemCommentSkill } from '../../../../src/shared/bots/bot-items'
import type { BotItemWaitingLine } from '../../../../src/shared/bots/bot-item-question-answers'
import { folderWorkspaceKey } from '../../../../src/shared/workspace/identity/workspace-scope'
import { SkillRefLimitError } from '../../../../src/shared/agent-session/requests/structured-agent-session-send-mutation'
import { sentBotItemCommentSkills } from '../../../../src/shared/bots/bot-item-comment-skills'
import type { BotItemHeldAnswersLimit } from '../../../../src/shared/bots/bot-item-held-answers'
import { MAX_SKILL_REFS } from '../../../../src/shared/rpc-contract/structured-agent-session/structured-agent-session-message-params'
import { SKILL_DISCOVER_WORKSPACE_CAPABILITY } from '../../../../src/shared/skills/capabilities/skill-install-capability'
import { MobileNativeChatComposerSuggestions } from '../../session/native-chat/composer/menus/MobileNativeChatComposerMenu'
import { useMobileNativeChatComposerMenu } from '../../session/native-chat/composer/menus/use-mobile-native-chat-composer-menu'
import { shownDictationPreview } from '../../session/native-chat/composer/menus/mobile-native-chat-bot-mention-display'
import { useMobileNativeChatWorkspaceCatalog } from '../../session/native-chat/composer/attachments/use-mobile-native-chat-workspace-catalog'
import { useRouteCapability } from '../../worktree/execution-hosts/use-route-capability'
import { ComposerSendButton } from '../../components/composer-input/ComposerSendButton'
import { MobileNativeChatComposerAttachButton } from '../../session/native-chat/composer/attachments/MobileNativeChatComposerAttachButton'
import { MobileNativeChatComposerAttachments } from '../../session/native-chat/composer/attachments/MobileNativeChatComposerAttachments'
import { COMPOSER_COMPACT_CONTROL_SIZE } from '../../components/composer-input/composer-input-styles'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { MobileNativeChatComposerField } from '../../session/native-chat/composer/field/MobileNativeChatComposerField'
import { MobileNativeChatComposerMic } from '../../session/native-chat/composer/dictation/MobileNativeChatComposerMic'
import { MobileNativeChatDictationLeading } from '../../session/native-chat/composer/dictation/MobileNativeChatDictationLeading'
import { useMobileNativeChatComposerDictation } from '../../session/native-chat/composer/dictation/use-mobile-native-chat-composer-dictation'
import {
  blurMobileNativeChatTextDestination,
  focusMobileNativeChatTextDestination
} from '../../session/native-chat/composer/drafts/mobile-native-chat-draft-inputs'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { colors, pressedStyle, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { BotItemCommentMicContext } from './bot-item-comment-mic'
import { MobileBotItemReplyQuote } from './MobileBotItemReplyQuote'
import { useBotDraftImages } from '../use-bot-draft-images'
import {
  botItemCommentDraftKey,
  botItemCommentDrafts as drafts,
  writeBotItemCommentDraft,
  shownBotItemCommentDrafts as shownDrafts
} from './bot-item-comment-drafts'

// Skills picked into each item's draft, by the file the comment's mail names.
const pickedSkills = new Map<string, readonly BotItemCommentSkill[]>()
const NO_SKILLS: readonly BotItemCommentSkill[] = []
const NO_FILES: readonly never[] = []

/** The agent's question the item waits on, and who asked it. */
export type BotItemWaitingQuestion = BotItemWaitingLine & { asker: string }

export function MobileBotItemCommentBox({
  client,
  hostId,
  bot,
  item,
  online,
  hostName,
  question = null,
  attachTo,
  onSend,
  showToast,
  fieldRef: input
}: {
  client: RpcClient | null
  hostId: string
  /** The item's bot: its folder's files list at `@` and its skills at `/`, as in its chat. */
  bot: { folderWorkspaceId: string; agent: string }
  item: BotItem
  online: boolean
  hostName: string
  /** The item's chat, which photos upload to; null when its comments take none. */
  attachTo: string | null
  /** Sends the comment, with the waiting line "Replying to" names (null once hidden): it shows in
   *  Activity until the host's read does. A limit the held answers would pass with it refuses it. */
  onSend: (
    text: string,
    paths: readonly string[],
    replyingTo: string | null,
    skills: readonly BotItemCommentSkill[]
  ) => BotItemHeldAnswersLimit | null
  showToast: (message: string) => void
  /** The agent's question waiting on the owner (what is sent is the reply). */
  question?: BotItemWaitingQuestion | null
  /** The field, which the page focuses for a quote. */
  fieldRef: RefObject<TextInputInstance | null>
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const mic = useContext(BotItemCommentMicContext)
  const key = botItemCommentDraftKey(hostId, item.uid)
  const [text, setTextState] = useState(() => drafts.get(key) ?? '')
  // The question whose "Replying to" the owner closed.
  const [unmarked, setUnmarked] = useState<string | null>(null)
  const quote = question && unmarked !== question.id ? question : null
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef<HostInstance>(null)
  const { uid } = item
  const setText = useCallback(
    (next: string) => {
      setTextState(next)
      setError(null)
      writeBotItemCommentDraft(key, next)
    },
    [key]
  )
  useEffect(() => {
    shownDrafts.set(key, setText)
    // Text returned to the draft between the first render and this registration shows too.
    setTextState(drafts.get(key) ?? '')
    return () => {
      shownDrafts.delete(key)
    }
  }, [key, setText])
  // A late transcript lands in this item's draft even after the box closed.
  const insertDictation = useCallback(
    (insert: (draft: string) => string) => setText(insert(drafts.get(key) ?? '')),
    [setText, key]
  )
  const boxRef = useRef<HostInstance>(null)
  const catalog = useMobileNativeChatWorkspaceCatalog(
    {
      hostId,
      client,
      worktreeId: folderWorkspaceKey(bot.folderWorkspaceId),
      agentSessionHostSupport: {
        discoverWorkspaceSkills: useRouteCapability(SKILL_DISCOVER_WORKSPACE_CAPABILITY)
      }
    },
    bot.agent
  )
  // The chat composer's `@` files and `/` skills; commands act on a chat, which a comment is not.
  const menu = useMobileNativeChatComposerMenu({
    value: text,
    onChangeText: setText,
    agent: bot.agent,
    structuredCatalog: undefined,
    skillsOnly: true,
    filePaths: catalog.nativeChatFilePaths,
    onNeedFiles: catalog.loadNativeChatFiles,
    skillDiscovery: catalog.nativeChatSkills,
    onNeedSkills: catalog.loadNativeChatSkills,
    // A scanned skill names no file chat would send; the comment's mail names the one it was found at.
    onPickSkill: (skill) => {
      const path = skill.path ?? skill.sources[0]?.skillFilePath
      const name = skill.token.slice(1)
      if (path) {
        const kept = (pickedSkills.get(key) ?? NO_SKILLS).filter((held) => held.name !== name)
        pickedSkills.set(key, [...kept, { name, path }])
      }
    },
    focusField: () => input.current?.focus()
  })
  const placeCaret = menu.placeCaret
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
  const photos = useBotDraftImages({
    client,
    draftKey: uid,
    sessionId: attachTo,
    editText: (change) => (shownDrafts.get(key) ?? setText)(change(drafts.get(key) ?? '')),
    showToast
  })
  const micActive = mic?.micActive ?? false
  // Send waits for every photo's upload, as on the desktop.
  const canSend =
    online &&
    (text.trim().length > 0 || photos.images.length > 0) &&
    !photos.uploading &&
    !micActive
  const send = () => {
    if (canSend) {
      let skills: BotItemCommentSkill[]
      try {
        skills = sentBotItemCommentSkills(text, pickedSkills.get(key) ?? NO_SKILLS, bot.agent)
      } catch (error) {
        if (!(error instanceof SkillRefLimitError)) {
          throw error
        }
        // The phone chat's words for the same refusal.
        setError(
          t(
            'bots.items.skillLimit',
            'Message not sent. Keep at most {{limit}} selected skill files and try again.',
            { limit: MAX_SKILL_REFS }
          )
        )
        return
      }
      const limit = onSend(
        text.trim(),
        photos.images.map((image) => image.path),
        quote?.id ?? null,
        skills
      )
      // Refused, the comment stays in the box, saying why.
      if (limit) {
        setError(
          limit.kind === 'images'
            ? t(
                'bots.items.ask.heldImagesLimit',
                'Your answers go as one comment, which takes up to {{max}} photos. Remove some and try again.',
                { max: limit.max }
              )
            : t(
                'bots.items.ask.heldSkillsLimit',
                'Your answers go as one comment, which takes up to {{max}} skills. Remove some and try again.',
                { max: limit.max }
              )
        )
        return
      }
      pickedSkills.delete(key)
      setText('')
      photos.clearSent(photos.images.map((image) => image.id))
    }
  }
  const notice = !online
    ? t(
        'bots.items.comment.offline',
        '{{host}} is offline. Your comment is kept; Comment works again when it’s back.',
        { host: hostName }
      )
    : null
  return (
    <View ref={boxRef} style={styles.box}>
      <MobileNativeChatComposerSuggestions anchorRef={boxRef} rows={menu.rows} onPick={menu.pick} />
      <MobileNativeChatComposerAttachments
        images={photos.images}
        files={NO_FILES}
        onRemoveImage={photos.remove}
        numbered
      />
      {quote ? (
        <View style={styles.quote}>
          <View style={styles.quoteText}>
            <MobileBotItemReplyQuote text={quote.line} onShowQuestion={null} />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('bots.items.comment.hideReplyingTo', 'Hide')}
            hitSlop={10}
            onPress={() => setUnmarked(quote.id)}
            style={({ pressed }) => pressed && pressedStyle}
          >
            <X size={13} color={colors.textMuted} />
          </Pressable>
        </View>
      ) : null}
      <View style={styles.row}>
        {attachTo ? (
          <View style={styles.micSlot}>
            <MobileNativeChatComposerAttachButton
              onAttachImage={() => void photos.attach()}
              onAttachFiles={undefined}
              structured={false}
              isAttaching={false}
              disabled={!online}
            />
          </View>
        ) : null}
        <View style={styles.field}>
          <MobileNativeChatComposerField
            ref={input}
            value={menu.display.text}
            skillToken={menu.skillToken}
            dictationPreview={shownDictationPreview(dictation.preview)}
            onChangeText={menu.onFieldChange}
            onFocus={() => focusMobileNativeChatTextDestination(scope)}
            // Controlled only transiently right after an autocomplete insert.
            selection={menu.pendingSelection ?? undefined}
            onSelectionChange={(event) => {
              dictation.readSelection(menu.dictationAnchor(event))
              menu.onSelectionChange(event.nativeEvent.selection)
            }}
            onKeyboardSubmit={() => {
              const first = menu.rows[0]
              if (first) {
                menu.pick(first)
              } else {
                send()
              }
            }}
            multiline
            accessibilityLabel={t('bots.items.comment.label', 'Comment')}
            placeholder={
              !quote
                ? t('bots.items.comment.add', 'Add a comment…')
                : quote.replies
                  ? t('bots.items.comment.reply', 'Reply in your own words')
                  : t('bots.items.comment.replyTo', 'Reply to {{name}}…', { name: quote.asker })
            }
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
              disabled={!online}
            />
          </View>
        ) : null}
        <ComposerSendButton
          size="compact"
          onPress={send}
          canSend={canSend}
          sending={false}
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
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  quote: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  quoteText: { flex: 1, minWidth: 0 },
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
