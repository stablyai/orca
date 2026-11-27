import { MobileSlackMirrorItem } from '../slack-mirror/MobileSlackMirrorItem'
import { getNativeChatAgentProfile } from '../../../../../src/shared/native-chat/input/commands/native-chat-agent-profiles'
import { recordMobileNativeChatSkillPick } from './drafts/mobile-native-chat-draft-store'
import { useMobileNativeChatComposerDictation } from './dictation/use-mobile-native-chat-composer-dictation'
import {
  focusMobileNativeChatTextDestination,
  pruneMobileNativeChatDraftSkills
} from './drafts/mobile-native-chat-draft-inputs'
import { MobileNativeChatComposerAllocation } from './field/MobileNativeChatComposerAllocation'
import { useRef, useState } from 'react'
import { Keyboard, View, type HostInstance, type TextInputInstance } from 'react-native'
import Animated from 'react-native-reanimated'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { MobileNativeChatComposerSuggestions } from './menus/MobileNativeChatComposerMenu'
import { MobileNativeChatComposerField } from './field/MobileNativeChatComposerField'
import { MobileNativeChatComposerModeRow } from './field/MobileNativeChatComposerModeRow'
import { MobileNativeChatComposerAttachments } from './attachments/MobileNativeChatComposerAttachments'
import type { PendingNativeChatFile } from './attachments/mobile-native-chat-file-attachment'
import { MobileNativeChatComposerAttachButton } from './attachments/MobileNativeChatComposerAttachButton'
import { useMobileNativeChatPickerPresentation } from '../input/session-options/use-mobile-native-chat-picker-presentation'
import type { PendingNativeChatImage } from './attachments/mobile-native-chat-image-attachment'
import { mobileNativeChatComposerPasteHandler } from './attachments/mobile-native-chat-composer-paste'
import { useMobileNativeChatComposerMenu } from './menus/use-mobile-native-chat-composer-menu'
import { useMobileNativeChatMentionBots } from './menus/use-mobile-native-chat-mention-bots'
import { shownDictationPreview } from './menus/mobile-native-chat-bot-mention-display'
import { mobileNativeChatComposerStylesSheet as stylesSheet } from './field/mobile-native-chat-composer-styles'
import { composerInputStylesSheet as inputStylesSheet } from '../../../components/composer-input/composer-input-styles'
import { MobileNativeChatComposerSendSlot } from './delivery/MobileNativeChatComposerSendSlot'
import { useMobileNativeChatComposerSend } from './delivery/use-mobile-native-chat-composer-send'
import { MobileNativeChatEditActions } from './field/MobileNativeChatEditActions'
import {
  MobileNativeChatContextLimitLine,
  mobileNativeChatContextNearLimit
} from './commands/MobileNativeChatContextUsage'
import { mobileNativeChatComposerModes } from './commands/mobile-native-chat-composer-modes'
import type { MobileNativeChatSendIntent } from './delivery/mobile-native-chat-send'
import { MobileNativeChatComposerMic } from './dictation/MobileNativeChatComposerMic'
import {
  MobileNativeChatDictationLeading,
  useMobileNativeChatDictationFailed
} from './dictation/MobileNativeChatDictationLeading'
import { useMobileNativeChatComposerCollapse } from './field/use-mobile-native-chat-composer-collapse'
import { useMobileNativeChatComposerGoalMode } from './commands/use-mobile-native-chat-composer-goal-mode'
import { useMobileNativeChatOrcaCommands } from './commands/use-mobile-native-chat-orca-commands'
import type { MobileNativeChatComposerProps } from './mobile-native-chat-composer-props'
import { MobileNativeChatMcpTray } from '../mcp/MobileNativeChatMcpTray'
import { MobileNativeChatQuoteTab } from './quotes/MobileNativeChatQuoteTab'
import { tuiAgentDisplayName } from '../../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { useThemedStyles } from '../../../theme/themed-styles'

const NO_FILE_PATHS: string[] = []
const NO_ATTACHMENTS: PendingNativeChatImage[] = []
const NO_FILES: PendingNativeChatFile[] = []

type Props = MobileNativeChatComposerProps

/** What a chat's composer sends through, which the chat view hands down from its route. */
export type MobileNativeChatSendProps = Pick<Props, 'onSend' | 'sendFollowUp'>

export function MobileNativeChatComposer({
  roomReplies,
  inputRef,
  draftScopeKey,
  insertDictation,
  editSession,
  onPickSkill,
  value,
  onChangeText,
  onSend,
  sendSurfaceId,
  getSendCompletionGeneration,
  getComposerEditGeneration,
  agent = null,
  structured = null,
  sessionOptions,
  contextUsage = null,
  onAttachImage,
  onPasteImages,
  attachments = NO_ATTACHMENTS,
  onRemoveAttachment,
  isAttaching = false,
  onMicPress,
  micActive = false,
  micStarting,
  micProcessing,
  dictationMode,
  onMicPressIn,
  onMicPressOut,
  disabled = false,
  offline = false,
  sendDisabled = false,
  placeholder,
  filePaths = NO_FILE_PATHS,
  roomMentions,
  onNeedFiles,
  fileReference,
  skillDiscovery,
  onNeedSkills,
  stop = null,
  sendFollowUp = null,
  steerHead
}: Props): React.JSX.Element {
  const inputStyles = useThemedStyles(inputStylesSheet)
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const fallbackInputRef = useRef<TextInputInstance>(null)
  const fieldRef = inputRef ?? fallbackInputRef
  const groupRef = useRef<HostInstance>(null)
  // This composer's ✕, which its own held mic may be released over.
  const cancelRef = useRef<HostInstance>(null)
  const [focused, setFocused] = useState(false)
  const pickerState = useMobileNativeChatPickerPresentation(
    sessionOptions?.controller.optionPickerRequest
  )
  const picker = pickerState[0]
  const files = structured?.files ?? NO_FILES
  const onWebPaste = mobileNativeChatComposerPasteHandler({
    disabled: disabled || offline || editSession?.locked === true,
    onPasteImages,
    onAttachPastedText: structured?.onAttachPastedText
  })
  // Only a structured chat's sends reach the host's mention context, as on the desktop.
  const mentionBots = useMobileNativeChatMentionBots(!roomMentions && structured !== null)
  const goal = useMobileNativeChatComposerGoalMode(structured, !!editSession, sendSurfaceId)
  const orca = useMobileNativeChatOrcaCommands({
    structured,
    agent,
    sendSurfaceId,
    editing: editSession !== undefined,
    clearDraft: () => onChangeText('')
  })
  const menu = useMobileNativeChatComposerMenu({
    value,
    onChangeText: (text) => {
      if (editSession && draftScopeKey) {
        pruneMobileNativeChatDraftSkills(
          draftScopeKey,
          text,
          getNativeChatAgentProfile(agent)?.skillPrefix ?? '/'
        )
      }
      onChangeText(text)
    },
    onPickSkill: (skill) => {
      if (onPickSkill && skill.path) {
        onPickSkill({ name: skill.token.slice(1), path: skill.path })
      }
      if (!editSession) {
        recordMobileNativeChatSkillPick(sendSurfaceId, skill)
      }
    },
    refuseCommand: editSession?.refuseCommand ?? orca.refusesPick,
    onPickOrcaCommand: editSession ? undefined : orca.onPickCommand,
    editing: editSession !== undefined,
    goalMode: goal.menu,
    agent,
    structuredCatalog: orca.catalog,
    interactionModeSupported:
      editSession?.interactionModeSupported ??
      sessionOptions?.controller.snapshot.some((entry) => entry.id === 'interactionMode'),
    admitsInteractionMode: (mode) =>
      sessionOptions?.controller.optionSurface?.admits?.('interactionMode', mode) === true,
    onPickInteractionMode: (mode) => sessionOptions?.controller.setOption('interactionMode', mode),
    filePaths,
    roomMentions,
    mentionBots,
    onNeedFiles,
    fileReference,
    skillDiscovery,
    onNeedSkills,
    onSlashMenuOpen: structured?.onSlashMenuOpen,
    onSlashMenuDemand: structured?.onSlashMenuDemand,
    focusField: () => fieldRef.current?.focus()
  })
  const dictation = useMobileNativeChatComposerDictation({
    draftScopeKey,
    value,
    insertDictation,
    placeCaret: menu.placeCaret
  })
  const delivery = useMobileNativeChatComposerSend({
    sendSurfaceId,
    getSendCompletionGeneration,
    getComposerEditGeneration
  })
  const sending = delivery.sending
  const sessionOptionDispatching = sessionOptions?.controller.pendingId != null
  const filesUploading = files.some((file) => file.path === null)
  const attachmentCount = attachments.length + files.length
  // An attachment alone is a valid send (desktop parity), so it rides even with no text.
  const canSend =
    (value.trim().length > 0 || attachmentCount > 0) &&
    !disabled &&
    !sendDisabled &&
    !sending &&
    !isAttaching &&
    !filesUploading &&
    !sessionOptionDispatching

  const handleSend = async (
    intent?: MobileNativeChatSendIntent,
    keepFocus = false
  ): Promise<void> => {
    if (
      !canSend ||
      delivery.inFlight() ||
      // Before goal mode too, so an Orca command never becomes an objective.
      orca.consume(value) ||
      goal.consumeBareGoal(value, () => onChangeText(''))
    ) {
      return
    }
    // Raw, not trimmed: the send seam owns the wire trim, and a rejection has
    // to hand the user back exactly what they typed (#14819).
    await delivery.send(
      () => goal.send(onSend, value, intent),
      () => {
        menu.resetCursor()
        // Why: the turn is now the agent's — the keyboard would cover the reply.
        // A rejected send keeps it up so the handed-back draft stays editable.
        if (!editSession && !keepFocus) {
          Keyboard.dismiss()
        }
      }
    )
  }

  const modes = mobileNativeChatComposerModes({
    options: sessionOptions?.controller,
    structured: structured !== null,
    editing: editSession !== undefined,
    offline,
    goalMenu: goal.menu,
    goalActive: goal.chip !== null,
    commands: menu.commands,
    contextUsage,
    onSend,
    fieldRef
  })
  const mic = onMicPress ? (
    <MobileNativeChatComposerMic
      {...{ onMicPress, micActive, micStarting, micProcessing, dictationMode }}
      {...{ onMicPressIn, onMicPressOut, cancelRef }}
      disabled={disabled || offline}
      filled
    />
  ) : null
  const micLive = micActive || micStarting === true || micProcessing === true
  const dictationFailed = useMobileNativeChatDictationFailed()
  // Idle and empty, the composer is one pill; focus, a draft, an attachment, an open picker or a context warning keeps it whole.
  const collapsed =
    !editSession &&
    !focused &&
    value === '' &&
    attachmentCount === 0 &&
    !isAttaching &&
    !micLive &&
    !dictationFailed &&
    picker == null &&
    menu.rows.length === 0 &&
    !mobileNativeChatContextNearLimit(modes.context.usage)
  const collapse = useMobileNativeChatComposerCollapse(collapsed)
  const followUp = goal.sendFollowUp(sendFollowUp)
  const headChord = goal.holdsFollowUp ? undefined : steerHead
  const content = (
    <View ref={groupRef} testID="native-chat-composer-group">
      <MobileNativeChatComposerSuggestions
        anchorRef={groupRef}
        rows={menu.rows}
        onPick={menu.pick}
        onOpenBotChats={menu.openBotChats}
        nestedScrollEnabled={editSession ? true : undefined}
      />
      <View style={styles.composerInset} testID="native-chat-composer-inset">
        {editSession ? null : <MobileNativeChatMcpTray panel={structured?.mcpPanel} />}
        {orca.usageSheet}
        {goal.strip}
        {editSession ? null : <MobileNativeChatQuoteTab {...{ value, onChangeText, fieldRef }} />}
        <Animated.View style={[styles.bar, collapse.frame]} testID="native-chat-composer">
          <View
            style={[styles.barContent, collapsed && styles.barContentPill]}
            onLayout={collapse.onContentLayout}
          >
            {collapsed ? null : <MobileNativeChatContextLimitLine {...modes.context} />}
            <MobileNativeChatComposerAttachments
              images={attachments}
              files={files}
              onRemoveImage={editSession?.locked ? undefined : onRemoveAttachment}
              onRemoveFile={editSession?.locked ? undefined : structured?.onRemoveFile}
            />
            <Animated.View style={[collapse.field, collapse.fade]}>
              <MobileNativeChatComposerField
                ref={fieldRef}
                value={menu.display.text}
                skillToken={menu.skillToken}
                onChangeText={menu.onFieldChange}
                onKeyboardSubmit={() => {
                  const first = menu.rows[0]
                  if (first) {
                    menu.pick(first)
                  } else if (editSession || value.trim() !== '' || attachmentCount > 0) {
                    void handleSend(editSession ? undefined : { alternate: true }, true)
                  } else {
                    // Nothing of its own to send, so the head card goes; the queue decides whether it may.
                    headChord?.run(followUp?.action === 'queue' && followUp.offersChoice)
                  }
                }}
                onFocus={() => {
                  setFocused(true)
                  if (draftScopeKey) {
                    focusMobileNativeChatTextDestination(draftScopeKey)
                  }
                }}
                onBlur={() => setFocused(false)}
                onWebPaste={onWebPaste}
                // Controlled only transiently right after an autocomplete insert.
                selection={menu.pendingSelection ?? undefined}
                dictationPreview={shownDictationPreview(dictation.preview)}
                onSelectionChange={(e) => {
                  dictation.readSelection(menu.dictationAnchor(e))
                  menu.onSelectionChange(e.nativeEvent.selection)
                }}
                placeholder={
                  goal.placeholder ?? placeholder ?? t('chat.composer.askAnything', 'Ask anything')
                }
                placeholderTextColor={colors.textMuted}
                selectionColor={colors.accentBlue}
                multiline
                editable={!editSession?.locked}
                // Why: never revoke `editable` — iOS resigns first responder on a focused
                // field, so a transient lock would yank the keyboard mid-typing (#10681).
                // The lock gates sending; the draft survives and rides the next send.
                textAlignVertical="top"
              />
            </Animated.View>
            <View
              style={[inputStyles.actionRow, collapsed && styles.pillActionRow]}
              testID="native-chat-composer-actions"
            >
              <MobileNativeChatDictationLeading
                {...{ micActive, micStarting, micProcessing, cancelRef }}
              >
                <MobileNativeChatComposerAttachButton
                  onAttachImage={onAttachImage}
                  onAttachFiles={structured?.onAttachFiles}
                  structured={structured !== null}
                  isAttaching={isAttaching}
                  disabled={disabled || offline}
                  menu={menu}
                  plan={modes.plan}
                  onGoal={modes.onGoal}
                />
                {collapsed ? null : (
                  <MobileNativeChatComposerModeRow
                    fade={collapse.fade}
                    roomReplies={roomReplies}
                    sessionOptions={sessionOptions}
                    title={tuiAgentDisplayName(agent ?? '') ?? undefined}
                    context={modes.context}
                    sendInFlight={sending || isAttaching}
                    picker={pickerState}
                    focused={focused}
                    fieldRef={fieldRef}
                    goalChip={goal.chip}
                  />
                )}
              </MobileNativeChatDictationLeading>
              {editSession ? mic : null}
              {editSession ? (
                <MobileNativeChatEditActions
                  canSave={canSend}
                  saving={sending}
                  onCancel={editSession.cancel}
                  onSave={() => void handleSend()}
                />
              ) : (
                <MobileNativeChatComposerSendSlot
                  {...{
                    fieldRef,
                    value,
                    draftScopeKey,
                    attachmentCount,
                    structured,
                    agent,
                    followUp,
                    canSend,
                    sending,
                    stop,
                    mic
                  }}
                  micLive={micLive}
                  snapshot={sessionOptions?.controller.snapshot}
                  steerHead={headChord}
                  pickerOpen={menu.rows.length > 0}
                  sendDisabled={sendDisabled}
                  attaching={isAttaching || filesUploading || micActive}
                  onSend={(intent, keepFocus) => void handleSend(intent, keepFocus)}
                  onWidth={collapse.onSlotWidth}
                />
              )}
            </View>
          </View>
        </Animated.View>
        {editSession ? null : <MobileSlackMirrorItem />}
      </View>
    </View>
  )
  return (
    <MobileNativeChatComposerAllocation
      anchorRef={groupRef}
      fieldRef={fieldRef}
      hasMenu={menu.rows.length > 0}
    >
      {content}
    </MobileNativeChatComposerAllocation>
  )
}
