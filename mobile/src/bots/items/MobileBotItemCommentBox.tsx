// The item page's comment box, docked at the bottom: it sends with the chat composer's arrow, and a sent
// comment shows in Activity at once while it goes (one that fails stays there with Retry). Closing the
// panel keeps each item's draft, photos too, for the session. Offline, Comment waits. The ask card's
// answer goes straight to the host; a dropped reply says it may have arrived, never resends.
// The chat's field and mic: the session's dictation lands here while the box is its target. Photos
// attach with the chat's + and thumbnails, each named [Image #N] in the words.
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
import { WifiOff } from 'lucide-react-native'
import type { BotItem, BotItemCommentSkill } from '../../../../src/shared/bots/bot-items'
import { folderWorkspaceKey } from '../../../../src/shared/workspace/identity/workspace-scope'
import { pickedSkillsInText } from '../../../../src/shared/agent-session/requests/structured-agent-session-send-mutation'
import { getNativeChatAgentProfile } from '../../../../src/shared/native-chat/input/commands/native-chat-agent-profiles'
import { SKILL_DISCOVER_WORKSPACE_CAPABILITY } from '../../../../src/shared/skills/capabilities/skill-install-capability'
import { MobileNativeChatComposerSuggestions } from '../../session/native-chat/composer/menus/MobileNativeChatComposerMenu'
import { useMobileNativeChatComposerMenu } from '../../session/native-chat/composer/menus/use-mobile-native-chat-composer-menu'
import { useMobileNativeChatWorkspaceCatalog } from '../../session/native-chat/composer/attachments/use-mobile-native-chat-workspace-catalog'
import { useRouteCapability } from '../../worktree/execution-hosts/use-route-capability'
import { ComposerSendButton } from '../../components/composer-input/ComposerSendButton'
import { MobileNativeChatComposerAttachButton } from '../../session/native-chat/composer/attachments/MobileNativeChatComposerAttachButton'
import { MobileNativeChatComposerAttachments } from '../../session/native-chat/composer/attachments/MobileNativeChatComposerAttachments'
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
import { useBotItemCommentImages } from './use-bot-item-comment-images'

// Each item's unsent text, for this app session.
const drafts = new Map<string, string>()
// Skills picked into each item's draft, by the file the comment's mail names.
const pickedSkills = new Map<string, readonly BotItemCommentSkill[]>()
const NO_SKILLS: readonly BotItemCommentSkill[] = []
// The open box of each item, so a late photo's [Image #N] change reaches the field it shows in.
const shownDrafts = new Map<string, (next: string) => void>()
const NO_FILES: readonly never[] = []

export type BotItemCommentBoxHandle = {
  /** Post `text` as the owner's comment, as Comment does (the ask card's answer): `unknown` when the
   *  reply dropped after sending, so it may have gone; `failed` when it surely didn't. */
  send: (text: string) => Promise<'landed' | 'unknown' | 'failed'>
}

export function MobileBotItemCommentBox({
  client,
  hostId,
  bot,
  item,
  online,
  hostName,
  waitingOn = null,
  attachTo,
  onComment,
  showToast,
  ref
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
  /** Sends the comment: it shows in Activity until the host's read does. */
  onComment: (
    text: string,
    paths: readonly string[],
    skills: readonly BotItemCommentSkill[]
  ) => void
  showToast: (message: string) => void
  /** The agent's question waiting on the owner (what is sent is the reply): who asked, and whether it
   *  gave quick replies. */
  waitingOn?: { replies: boolean; asker: string } | null
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
  useEffect(() => {
    shownDrafts.set(uid, setText)
    return () => {
      shownDrafts.delete(uid)
    }
  }, [uid, setText])
  // A late transcript lands in this item's draft even after the box closed.
  const insertDictation = useCallback(
    (insert: (draft: string) => string) => setText(insert(drafts.get(uid) ?? '')),
    [setText, uid]
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
        const kept = (pickedSkills.get(uid) ?? NO_SKILLS).filter((held) => held.name !== name)
        pickedSkills.set(uid, [...kept, { name, path }])
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
  const photos = useBotItemCommentImages({
    client,
    uid,
    sessionId: attachTo,
    editText: (change) => (shownDrafts.get(uid) ?? setText)(change(drafts.get(uid) ?? '')),
    showToast
  })
  const micActive = mic?.micActive ?? false
  // Send waits for every photo's upload, as on the desktop.
  const canSend =
    online &&
    (text.trim().length > 0 || photos.images.length > 0) &&
    !photos.uploading &&
    !micActive
  const post = async (words: string): Promise<'landed' | 'unknown' | 'failed'> => {
    if (!online || !words || sending || !client) {
      return 'failed'
    }
    setSending(true)
    const outcome = await commentOnBotItem(client, item.uid, words)
    setSending(false)
    if (outcome.kind === 'done') {
      setError(null)
      return 'landed'
    }
    triggerError()
    setError(botItemWriteFailure(outcome, hostName, t))
    return outcome.kind === 'unknown' ? 'unknown' : 'failed'
  }
  const send = () => {
    if (canSend) {
      const sigil = getNativeChatAgentProfile(bot.agent)?.skillPrefix ?? '/'
      onComment(
        text.trim(),
        photos.images.map((image) => image.path),
        pickedSkillsInText(text, pickedSkills.get(uid) ?? NO_SKILLS, [sigil])
      )
      pickedSkills.delete(uid)
      setText('')
      photos.clear()
    }
  }
  useImperativeHandle(ref, () => ({
    send: (words) => post(words.trim())
  }))
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
      <View style={styles.row}>
        {attachTo ? (
          <View style={styles.micSlot}>
            <MobileNativeChatComposerAttachButton
              onAttachImage={() => void photos.attach()}
              onAttachFiles={undefined}
              structured={false}
              isAttaching={false}
              disabled={!online || sending}
            />
          </View>
        ) : null}
        <View style={styles.field}>
          <MobileNativeChatComposerField
            ref={input}
            value={text}
            skillToken={menu.skillToken}
            dictationPreview={dictation.preview}
            onChangeText={menu.onFieldChange}
            onFocus={() => focusMobileNativeChatTextDestination(scope)}
            // Controlled only transiently right after an autocomplete insert.
            selection={menu.pendingSelection ?? undefined}
            onSelectionChange={(event) => {
              dictation.readSelection(event)
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
            editable={!sending}
            multiline
            accessibilityLabel={t('bots.items.comment.label', 'Comment')}
            placeholder={
              !waitingOn
                ? t('bots.items.comment.add', 'Add a comment…')
                : waitingOn.replies
                  ? t('bots.items.comment.reply', 'Reply in your own words')
                  : t('bots.items.comment.replyTo', 'Reply to {{name}}…', { name: waitingOn.asker })
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
              disabled={!online || sending}
            />
          </View>
        ) : null}
        <ComposerSendButton
          size="compact"
          onPress={send}
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
