import { getNativeChatAgentProfile } from '../../../../../src/shared/native-chat-agent-profiles'
import {
  recordMobileNativeChatSkillPick,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'
import { useMobileNativeChatComposerDictation } from './use-mobile-native-chat-composer-dictation'
import {
  focusMobileNativeChatTextDestination,
  pruneMobileNativeChatDraftSkills
} from './mobile-native-chat-draft-inputs'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ActivityIndicator, Keyboard, Pressable, type TextInput, Text, View } from 'react-native'
import { Plus } from 'lucide-react-native'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { MobileNativeChatComposerMenu } from './MobileNativeChatComposerMenu'
import { MobileNativeChatComposerField } from './MobileNativeChatComposerField'
import { MobileNativeChatComposerAttachments } from './MobileNativeChatComposerAttachments'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import { ActionSheetModal } from '../../../components/ActionSheetModal'
import { mobileNativeChatAttachActions } from '../../mobile-native-chat-attach-actions'
import {
  MobileNativeChatSessionOptionPickers,
  type MobileNativeChatPickerPresentation
} from '../input/MobileNativeChatSessionOptionPickers'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import { useMobileNativeChatComposerMenu } from './use-mobile-native-chat-composer-menu'
import { mobileNativeChatComposerShowsStop } from './mobile-native-chat-composer-layout'
import { MobileNativeChatStopButton } from '../input/MobileNativeChatStopButton'
import { mobileNativeChatComposerStyles as styles } from './mobile-native-chat-composer-styles'
import { composerInputStyles as inputStyles } from '../../../components/composer-input/composer-input-styles'
import { MobileNativeChatSendButton } from './MobileNativeChatSendButton'
import type { MobileNativeChatSendIntent } from '../mobile-native-chat-send'
import { MobileNativeChatComposerMic } from './MobileNativeChatComposerMic'

const NO_FILE_PATHS: string[] = []
const NO_ATTACHMENTS: PendingNativeChatImage[] = []
const NO_FILES: PendingNativeChatFile[] = []

import type { Props } from './mobile-native-chat-composer-props'
export type {
  MobileNativeChatStructuredComposer,
  MobileNativeChatSendProps
} from './mobile-native-chat-composer-props'

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
  onAttachImage,
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
  setupAgentStartHeld = false,
  setupInputHeld = setupAgentStartHeld,
  disabled = false,
  sendDisabled = false,
  placeholder,
  filePaths = NO_FILE_PATHS,
  onNeedFiles,
  skillDiscovery,
  onNeedSkills,
  stop = null,
  sendFollowUp = null
}: Props): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const fallbackInputRef = useRef<TextInput>(null)
  const fieldRef = inputRef ?? fallbackInputRef
  const [focused, setFocused] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [picker, setPicker] = useState<MobileNativeChatPickerPresentation | null>(null)
  const request = sessionOptions?.controller.optionPickerRequest
  const [lastRequest, setLastRequest] = useState(request)
  if (request && lastRequest !== request) {
    setLastRequest(request)
    setPicker({ page: request.id, refocus: false })
  }
  const files = structured?.files ?? NO_FILES
  const setupHeldRef = useRef(setupInputHeld)
  useLayoutEffect(() => {
    setupHeldRef.current = setupInputHeld
  }, [setupInputHeld])
  const editing =
    <TArgs extends unknown[]>(action: ((...args: TArgs) => void) | undefined) =>
    (...args: TArgs): void => {
      if (!setupHeldRef.current) {
        action?.(...args)
      }
    }
  const menu = useMobileNativeChatComposerMenu({
    value,
    onChangeText: (text) => {
      if (setupHeldRef.current) {
        return
      }
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
      if (setupHeldRef.current) {
        return
      }
      if (onPickSkill && skill.path) {
        onPickSkill({ name: skill.token.slice(1), path: skill.path })
      }
      if (!editSession) {
        recordMobileNativeChatSkillPick(sendSurfaceId, skill)
      }
    },
    refuseCommand: editSession?.refuseCommand,
    editing: editSession !== undefined,
    agent,
    structuredCatalog: structured?.catalog,
    filePaths,
    onNeedFiles,
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
    isEditingHeld: () => setupHeldRef.current,
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
    !setupInputHeld &&
    !disabled &&
    !sendDisabled &&
    !sending &&
    !isAttaching &&
    !filesUploading &&
    !sessionOptionDispatching
  const showsStop =
    (setupInputHeld && stop !== null) ||
    mobileNativeChatComposerShowsStop({
      canStop: stop !== null,
      sendBlocked: sendDisabled,
      canSend,
      editing: isAttaching || filesUploading || micActive,
      draft: value,
      attachmentCount
    })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sendSurfaceGenerationRef.current += 1
    }
  }, [])

  const handleSend = async (intent?: MobileNativeChatSendIntent): Promise<void> => {
    if (setupHeldRef.current || !canSend || sendingRef.current) {
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
      const accepted = await (intent ? onSend(value, intent) : onSend(value))
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
        if (!editSession) {
          Keyboard.dismiss()
        }
      }
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  // A terminal-backed chat has only photos to add, so its + opens the library at once.
  const attachPress = structured ? () => setAttachOpen(true) : onAttachImage
  const attachLabel = structured
    ? t('chat.composer.addToMessage', 'Add to message')
    : t('chat.composer.attachImage', 'Attach image')

  return (
    <View>
      {!setupInputHeld && menu.rows.length > 0 ? (
        <MobileNativeChatComposerMenu
          rows={menu.rows}
          onPick={menu.pick}
          nestedScrollEnabled={editSession ? true : undefined}
        />
      ) : null}
      <View style={styles.composerInset} testID="native-chat-composer-inset">
        <View style={styles.bar} testID="native-chat-composer">
          <MobileNativeChatComposerAttachments
            images={attachments}
            files={files}
            onRemoveImage={editSession?.locked ? undefined : editing(onRemoveAttachment)}
            onRemoveFile={editSession?.locked ? undefined : editing(structured?.onRemoveFile)}
          />
          <MobileNativeChatComposerField
            ref={fieldRef}
            value={value}
            skillToken={menu.skillToken}
            onChangeText={editing(menu.onFieldChange)}
            onFocus={() => {
              setFocused(true)
              if (draftScopeKey) {
                focusMobileNativeChatTextDestination(draftScopeKey)
              }
            }}
            onBlur={() => setFocused(false)}
            // Controlled only transiently right after an autocomplete insert.
            selection={menu.pendingSelection ?? undefined}
            dictationPreview={dictation.preview}
            onSelectionChange={(e) => {
              dictation.readSelection(e)
              menu.onSelectionChange(e.nativeEvent.selection)
            }}
            placeholder={
              placeholder ??
              t('chat.composer.placeholder', 'Ask anything, @ to mention files, / for commands')
            }
            placeholderTextColor={colors.textMuted}
            selectionColor={colors.accentBlue}
            multiline
            editable={!setupInputHeld && !editSession?.locked}
            // Why: never revoke `editable` — iOS resigns first responder on a focused
            // field, so a transient lock would yank the keyboard mid-typing (#10681).
            // The lock gates sending; the draft survives and rides the next send.
            textAlignVertical="top"
          />
          <View style={inputStyles.actionRow} testID="native-chat-composer-actions">
            {attachPress ? (
              <Pressable
                accessibilityLabel={attachLabel}
                style={({ pressed }) => [inputStyles.controlButton, pressed && inputStyles.pressed]}
                onPress={editing(attachPress)}
                disabled={setupInputHeld || isAttaching || disabled}
              >
                {isAttaching ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : (
                  <Plus size={19} color={colors.textPrimary} strokeWidth={2} />
                )}
              </Pressable>
            ) : null}
            {sessionOptions && !setupInputHeld ? (
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
            <View style={inputStyles.actionSpacer} />
            {onMicPress ? (
              <MobileNativeChatComposerMic
                onMicPress={editing(onMicPress)}
                micActive={micActive}
                micStarting={micStarting}
                micProcessing={micProcessing}
                dictationMode={dictationMode}
                onMicPressIn={editing(onMicPressIn)}
                onMicPressOut={onMicPressOut}
                disabled={setupInputHeld || disabled}
              />
            ) : null}
            {editSession ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('chat.composer.cancelEditing', 'Cancel editing')}
                style={inputStyles.ghostButton}
                onPress={editSession.cancel}
              >
                <Text style={{ color: colors.textSecondary }}>{t('common.cancel', 'Cancel')}</Text>
              </Pressable>
            ) : null}
            {showsStop && stop ? (
              // Only this phone's own request holds Stop: a repeat is how a stuck stop escalates.
              <MobileNativeChatStopButton onStop={stop.onStop} held={stop.held} />
            ) : editSession ? (
              <Pressable
                accessibilityLabel={t('chat.composer.saveEditedMessage', 'Save edited message')}
                style={({ pressed }) => [
                  inputStyles.sendButton,
                  !canSend && inputStyles.sendButtonDisabled,
                  pressed && canSend && inputStyles.pressed
                ]}
                onPress={() => void handleSend()}
                disabled={!canSend}
              >
                <Text style={{ color: canSend ? colors.bgBase : colors.textMuted }}>
                  {t('common.save', 'Save')}
                </Text>
              </Pressable>
            ) : (
              <MobileNativeChatSendButton
                canSend={canSend}
                sendFollowUp={sendFollowUp}
                onSend={(intent) => void handleSend(intent)}
              />
            )}
          </View>
        </View>
      </View>
      {structured ? (
        <ActionSheetModal
          visible={attachOpen && !setupInputHeld}
          onClose={() => setAttachOpen(false)}
          actions={mobileNativeChatAttachActions({
            onPhotos: editing(onAttachImage),
            onFiles: editing(structured.onAttachFiles),
            onWorkspaceFile: editing(menu.openFileMenu),
            onSkills: editing(() => menu.openSlashMenu('skill')),
            onCommands: editing(() => menu.openSlashMenu('command')),
            skillCount: menu.skillCount
          })}
        />
      ) : null}
    </View>
  )
}

export function MobileNativeChatDraftComposer({
  draftKey,
  ...props
}: Omit<Props, 'value'> & { draftKey: string | null }): React.JSX.Element {
  return <MobileNativeChatComposer {...props} value={useMobileNativeChatDraft(draftKey)} />
}
