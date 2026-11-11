import { getNativeChatAgentProfile } from '../../../../../src/shared/native-chat/native-chat-agent-profiles'
import type { NativeChatSendFollowUp } from '../../../../../src/shared/native-chat/input/native-chat-follow-up-behavior'
import {
  recordMobileNativeChatSkillPick,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'
import { useMobileNativeChatComposerDictation } from './use-mobile-native-chat-composer-dictation'
import {
  focusMobileNativeChatTextDestination,
  pruneMobileNativeChatDraftSkills
} from './mobile-native-chat-draft-inputs'
import type { NativeChatSkillDiscoverySnapshot } from '../../../../../src/shared/native-chat/input/native-chat-picker-items'
import { MobileNativeChatComposerAllocation } from './MobileNativeChatComposerAllocation'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Keyboard, type TextInput, View } from 'react-native'
import type { NativeChatContextUsageSummary } from '../../../../../src/shared/native-chat/native-chat-context-usage-summary'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { MobileNativeChatComposerSuggestions } from './MobileNativeChatComposerMenu'
import { MobileNativeChatComposerField } from './MobileNativeChatComposerField'
import { MobileNativeChatComposerAttachments } from './MobileNativeChatComposerAttachments'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import { MobileNativeChatComposerAttachButton } from './MobileNativeChatComposerAttachButton'
import {
  MobileNativeChatSessionOptionPickers,
  type MobileNativeChatSessionOptionPickersProps
} from '../input/MobileNativeChatSessionOptionPickers'
import { useMobileNativeChatPickerPresentation } from '../input/use-mobile-native-chat-picker-presentation'
import type { MobileNativeChatSteerHead } from './use-mobile-native-chat-composer-tray'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import {
  mobileNativeChatComposerPasteHandler,
  type MobilePastedImages
} from './mobile-native-chat-composer-paste'
import { useMobileNativeChatComposerMenu } from './use-mobile-native-chat-composer-menu'
import { mobileNativeChatComposerStyles as styles } from './mobile-native-chat-composer-styles'
import { composerInputStyles as inputStyles } from '../../../components/composer-input/composer-input-styles'
import { MobileNativeChatComposerSendSlot } from './MobileNativeChatComposerSendSlot'
import { MobileNativeChatEditActions } from './MobileNativeChatEditActions'
import { MobileNativeChatClaudeSessionStatus } from './MobileNativeChatClaudeSessionStatusRow'
import { useMobileNativeChatContextRing } from './MobileNativeChatContextUsageRing'
import type { MobileNativeChatSendIntent } from './mobile-native-chat-send'
import { MobileNativeChatComposerMic } from './MobileNativeChatComposerMic'
import type { MobileNativeChatMicProps } from './MobileNativeChatComposerMic'
import { MobileNativeChatDictationLeading } from './MobileNativeChatDictationLeading'
import type { MobileNativeChatStructuredComposer } from './mobile-native-chat-structured-composer'
import { useMobileNativeChatComposerGoalMode } from './use-mobile-native-chat-composer-goal-mode'
import { MobileNativeChatComposerPlanChip } from './MobileNativeChatComposerPlanChip'

const NO_FILE_PATHS: string[] = []
const NO_ATTACHMENTS: PendingNativeChatImage[] = []
const NO_FILES: PendingNativeChatFile[] = []

type Props = MobileNativeChatMicProps & {
  // Applies dictation's edit to the draft this composer shows; false when it can no longer take it.
  insertDictation?: (insert: (draft: string) => string) => boolean | void
  draftScopeKey?: string | null
  editSession?: {
    cancel: () => void
    refuseCommand: (text: string) => boolean
    locked: boolean
    interactionModeSupported?: boolean
  }
  onPickSkill?: (skill: { name: string; path: string }) => void
  inputRef?: React.RefObject<TextInput | null>
  // Terminal-backed chats keep curated commands and image-only attachment actions.
  structured?: MobileNativeChatStructuredComposer | null
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string, intent?: MobileNativeChatSendIntent) => Promise<boolean>
  /** While the agent works on a host that queues: what a tap on Send does and whether holding it offers the other way; null otherwise. */
  sendFollowUp?: NativeChatSendFollowUp | null
  /** Cmd/Ctrl+Enter on an empty composer: steers the head queued card, or with no turn running sends it. */
  steerHead?: MobileNativeChatSteerHead
  /** Changes whenever the route focuses a different chat composer surface. */
  sendSurfaceId: string
  /** Reads the retained route's focus generation without forcing a screen render. */
  getSendCompletionGeneration: () => number
  getComposerEditGeneration: () => number
  agent?: string | null
  sessionOptions?: MobileNativeChatSessionOptionPickersProps | null
  /** A structured chat's context-window readout; null hides the ring. */
  contextUsage?: NativeChatContextUsageSummary | null
  onAttachImage?: () => void
  /** Images pasted into the field attach like a Photos pick. */
  onPasteImages?: (paste: MobilePastedImages) => void
  attachments?: PendingNativeChatImage[]
  onRemoveAttachment?: (id: string) => void
  isAttaching?: boolean
  disabled?: boolean
  /** The desktop is out: typing and Send (which queues) still work; attaching and dictation can't. */
  offline?: boolean
  /** Only Send is unavailable; typing, dictation and attachments still edit the draft. */
  sendDisabled?: boolean
  placeholder?: string
  filePaths?: string[]
  onNeedFiles?: (query: string) => void
  /** The host's disk-scanned skills, loaded once a skill trigger opens. */
  skillDiscovery?: NativeChatSkillDiscoverySnapshot
  onNeedSkills?: () => void
  /** Set while the agent can be stopped; Stop takes Send's slot when Send can't deliver. */
  stop?: { onStop?: () => void; held: boolean } | null
}

/** What a chat's composer sends through, which the chat view hands down from its route. */
export type MobileNativeChatSendProps = Pick<Props, 'onSend' | 'sendFollowUp'>

export function MobileNativeChatComposer({
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
  onNeedFiles,
  skillDiscovery,
  onNeedSkills,
  stop = null,
  sendFollowUp = null,
  steerHead
}: Props): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const fallbackInputRef = useRef<TextInput>(null)
  const fieldRef = inputRef ?? fallbackInputRef
  const groupRef = useRef<View>(null)
  // This composer's ✕, which its own held mic may be released over.
  const cancelRef = useRef<View>(null)
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
  const goal = useMobileNativeChatComposerGoalMode(structured, !!editSession, sendSurfaceId)
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
    refuseCommand: editSession?.refuseCommand,
    editing: editSession !== undefined,
    goalMode: goal.menu,
    agent,
    structuredCatalog: structured?.catalog,
    interactionModeSupported:
      editSession?.interactionModeSupported ??
      sessionOptions?.controller.snapshot.some((entry) => entry.id === 'interactionMode'),
    admitsInteractionMode: (mode) =>
      sessionOptions?.controller.optionSurface?.admits?.('interactionMode', mode) === true,
    onPickInteractionMode: (mode) => sessionOptions?.controller.setOption('interactionMode', mode),
    filePaths,
    onNeedFiles,
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
    if (!canSend || sendingRef.current || goal.consumeBareGoal(value, () => onChangeText(''))) {
      return
    }
    sendingRef.current = true
    setSending(true)
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
        nestedScrollEnabled={editSession ? true : undefined}
      />
      <View style={styles.composerInset} testID="native-chat-composer-inset">
        {goal.strip}
        <View {...contextRing.barProps} style={styles.bar} testID="native-chat-composer">
          <MobileNativeChatClaudeSessionStatus />
          <MobileNativeChatComposerAttachments
            images={attachments}
            files={files}
            onRemoveImage={editSession?.locked ? undefined : onRemoveAttachment}
            onRemoveFile={editSession?.locked ? undefined : structured?.onRemoveFile}
          />
          <MobileNativeChatComposerField
            ref={fieldRef}
            value={value}
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
            dictationPreview={dictation.preview}
            onSelectionChange={(e) => {
              dictation.readSelection(e)
              menu.onSelectionChange(e.nativeEvent.selection)
            }}
            placeholder={
              goal.placeholder ??
              placeholder ??
              t('chat.composer.placeholder', 'Ask anything, @ to mention files, / for commands')
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

export function MobileNativeChatDraftComposer({
  draftKey,
  ...props
}: Omit<Props, 'value'> & { draftKey: string | null }): React.JSX.Element {
  return <MobileNativeChatComposer {...props} value={useMobileNativeChatDraft(draftKey)} />
}
