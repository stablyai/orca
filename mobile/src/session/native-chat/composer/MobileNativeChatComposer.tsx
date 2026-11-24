import { MobileSlackMirrorItem } from '../slack-mirror/MobileSlackMirrorItem'
import { getNativeChatAgentProfile } from '../../../../../src/shared/native-chat/input/commands/native-chat-agent-profiles'
import { recordMobileNativeChatSkillPick } from './drafts/mobile-native-chat-draft-store'
import { useMobileNativeChatComposerDictation } from './dictation/use-mobile-native-chat-composer-dictation'
import {
  focusMobileNativeChatTextDestination,
  pruneMobileNativeChatDraftSkills
} from './drafts/mobile-native-chat-draft-inputs'
import { MobileNativeChatComposerAllocation } from './field/MobileNativeChatComposerAllocation'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Keyboard, View, type HostInstance, type TextInputInstance } from 'react-native'
import { colors } from '../../../theme/mobile-theme'
import { triggerSelection } from '../../../platform/haptics/haptics'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { MobileNativeChatComposerSuggestions } from './menus/MobileNativeChatComposerMenu'
import { MobileNativeChatComposerField } from './field/MobileNativeChatComposerField'
import { MobileNativeChatComposerAttachments } from './attachments/MobileNativeChatComposerAttachments'
import type { PendingNativeChatFile } from './attachments/mobile-native-chat-file-attachment'
import { MobileNativeChatComposerAttachButton } from './attachments/MobileNativeChatComposerAttachButton'
import { MobileNativeChatSessionOptionPickers } from '../input/session-options/MobileNativeChatSessionOptionPickers'
import { useMobileNativeChatPickerPresentation } from '../input/session-options/use-mobile-native-chat-picker-presentation'
import type { PendingNativeChatImage } from './attachments/mobile-native-chat-image-attachment'
import { mobileNativeChatComposerPasteHandler } from './attachments/mobile-native-chat-composer-paste'
import { useMobileNativeChatComposerMenu } from './menus/use-mobile-native-chat-composer-menu'
import { useMobileNativeChatMentionBots } from './menus/use-mobile-native-chat-mention-bots'
import { shownDictationPreview } from './menus/mobile-native-chat-bot-mention-display'
import { mobileNativeChatComposerStyles as styles } from './field/mobile-native-chat-composer-styles'
import { composerInputStyles as inputStyles } from '../../../components/composer-input/composer-input-styles'
import { MobileNativeChatComposerSendSlot } from './delivery/MobileNativeChatComposerSendSlot'
import { MobileNativeChatEditActions } from './field/MobileNativeChatEditActions'
import { useMobileNativeChatContextRing } from './commands/MobileNativeChatContextUsageRing'
import type { MobileNativeChatSendIntent } from './delivery/mobile-native-chat-send'
import { MobileNativeChatComposerMic } from './dictation/MobileNativeChatComposerMic'
import { MobileNativeChatDictationLeading } from './dictation/MobileNativeChatDictationLeading'
import { useMobileNativeChatComposerGoalMode } from './commands/use-mobile-native-chat-composer-goal-mode'
import { useMobileNativeChatOrcaCommands } from './commands/use-mobile-native-chat-orca-commands'
import { MobileNativeChatComposerPlanChip } from './commands/MobileNativeChatComposerPlanChip'
import type { MobileNativeChatComposerProps } from './mobile-native-chat-composer-props'
import { MobileNativeChatMcpTray } from '../mcp/MobileNativeChatMcpTray'
import { MobileNativeChatQuoteTab } from './quotes/MobileNativeChatQuoteTab'
import { MobileNativeChatWidthToggle } from './MobileNativeChatWidthToggle'
export type { MobileNativeChatStructuredComposer } from './commands/mobile-native-chat-structured-composer'

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
  fitScreenCorners = false,
  widthToggle = null,
  steerHead
}: Props): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const fallbackInputRef = useRef<TextInputInstance>(null)
  const fieldRef = inputRef ?? fallbackInputRef
  const groupRef = useRef<HostInstance>(null)
  // This composer's ✕, which its own held mic may be released over.
  const cancelRef = useRef<HostInstance>(null)
  const [focused, setFocused] = useState(false)
  const [picker, setPicker] = useMobileNativeChatPickerPresentation(
    sessionOptions?.controller.optionPickerRequest
  )
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
  const contextRing = useMobileNativeChatContextRing(contextUsage, menu.rows.length > 0)
  const dictation = useMobileNativeChatComposerDictation({
    draftScopeKey,
    value,
    insertDictation,
    placeCaret: menu.placeCaret
  })
  const sendingRef = useRef(false)
  const mountedRef = useRef(true)
  const sendSurfaceIdRef = useRef(sendSurfaceId)
  const sendSurfaceGenerationRef = useRef(0)
  useLayoutEffect(() => {
    if (sendSurfaceIdRef.current !== sendSurfaceId) {
      sendSurfaceIdRef.current = sendSurfaceId
      sendSurfaceGenerationRef.current += 1
    }
  }, [sendSurfaceId])
  const [sending, setSending] = useState(false)
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

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sendSurfaceGenerationRef.current += 1
    }
  }, [])

  const handleSend = async (
    intent?: MobileNativeChatSendIntent,
    keepFocus = false
  ): Promise<void> => {
    if (
      !canSend ||
      sendingRef.current ||
      // Before goal mode too, so an Orca command never becomes an objective.
      orca.consume(value) ||
      goal.consumeBareGoal(value, () => onChangeText(''))
    ) {
      return
    }
    sendingRef.current = true
    setSending(true)
    triggerSelection()
    const sendSurfaceGeneration = sendSurfaceGenerationRef.current
    const sendCompletionGeneration = getSendCompletionGeneration()
    const composerEditGeneration = getComposerEditGeneration()
    try {
      // Raw, not trimmed: the send seam owns the wire trim, and a rejection has
      // to hand the user back exactly what they typed (#14819).
      const accepted = await goal.send(onSend, value, intent)
      if (
        accepted &&
        mountedRef.current &&
        sendSurfaceGeneration === sendSurfaceGenerationRef.current &&
        sendCompletionGeneration === getSendCompletionGeneration() &&
        composerEditGeneration === getComposerEditGeneration()
      ) {
        menu.resetCursor()
        // Why: the turn is now the agent's — the keyboard would cover the reply.
        // A rejected send keeps it up so the handed-back draft stays editable.
        if (!editSession && !keepFocus) {
          Keyboard.dismiss()
        }
      }
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

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
      <View
        style={fitScreenCorners ? styles.composerInsetCornerFit : styles.composerInset}
        testID="native-chat-composer-inset"
      >
        {editSession ? null : <MobileNativeChatMcpTray panel={structured?.mcpPanel} />}
        {orca.usageSheet}
        {goal.strip}
        {editSession ? null : <MobileNativeChatQuoteTab {...{ value, onChangeText, fieldRef }} />}
        <View
          {...contextRing.barProps}
          style={fitScreenCorners ? styles.barCornerFit : styles.bar}
          testID="native-chat-composer"
        >
          <MobileNativeChatComposerAttachments
            images={attachments}
            files={files}
            onRemoveImage={editSession?.locked ? undefined : onRemoveAttachment}
            onRemoveFile={editSession?.locked ? undefined : structured?.onRemoveFile}
          />
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
              goal.placeholder ??
              placeholder ??
              (mentionBots && mentionBots.bots.length > 0
                ? t(
                    'bots.chat.mentionPlaceholder',
                    'Ask anything, @ to mention bots or files, / for commands'
                  )
                : t(
                    'chat.composer.placeholder',
                    'Ask anything, @ to mention files, / for commands'
                  ))
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
          <View style={inputStyles.actionRow} testID="native-chat-composer-actions">
            <MobileNativeChatDictationLeading
              {...{ micActive, micStarting, micProcessing, cancelRef, trailing: contextRing.ring }}
            >
              <MobileNativeChatComposerAttachButton
                onAttachImage={onAttachImage}
                onAttachFiles={structured?.onAttachFiles}
                structured={structured !== null}
                isAttaching={isAttaching}
                disabled={disabled || offline}
                menu={menu}
              />
              {roomReplies}
              {sessionOptions ? (
                <MobileNativeChatSessionOptionPickers
                  {...sessionOptions}
                  sendInFlight={sending || isAttaching}
                  presentation={picker}
                  onNavigate={(page) => setPicker((current) => current && { ...current, page })}
                  onDrawerOpen={(page) => setPicker({ page, refocus: focused })}
                  onDrawerAfterClose={() => {
                    if (picker?.refocus) {
                      fieldRef.current?.focus()
                    }
                    setPicker(null)
                  }}
                />
              ) : null}
              <MobileNativeChatComposerPlanChip options={sessionOptions} inputRef={fieldRef} />
              {goal.chip}
              {widthToggle ? <MobileNativeChatWidthToggle {...widthToggle} /> : null}
            </MobileNativeChatDictationLeading>
            {onMicPress ? (
              <MobileNativeChatComposerMic
                {...{ onMicPress, micActive, micStarting, micProcessing, dictationMode }}
                {...{ onMicPressIn, onMicPressOut, cancelRef }}
                disabled={disabled || offline}
              />
            ) : null}
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
                  stop
                }}
                snapshot={sessionOptions?.controller.snapshot}
                steerHead={headChord}
                pickerOpen={menu.rows.length > 0}
                sendDisabled={sendDisabled}
                attaching={isAttaching || filesUploading || micActive}
                onSend={(intent, keepFocus) => void handleSend(intent, keepFocus)}
              />
            )}
          </View>
        </View>
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
