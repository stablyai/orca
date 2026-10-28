import { getNativeChatAgentProfile } from '../../../../../src/shared/native-chat-agent-profiles'
import {
  recordMobileNativeChatSkillPick,
  setMobileNativeChatDraftText,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'
import { appendBufferedDictation } from '../../../terminal/terminal-live-dictation-routing'
import {
  focusMobileNativeChatTextDestination,
  pruneMobileNativeChatDraftSkills,
  registerMobileNativeChatTextDestination
} from './mobile-native-chat-draft-inputs'
import type { NativeChatSkillDiscoverySnapshot } from '../../../../../src/shared/native-chat/input/native-chat-picker-items'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ActivityIndicator, Keyboard, Pressable, type TextInput, Text, View } from 'react-native'
import { ArrowUp, Mic, Plus, Square } from 'lucide-react-native'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { NATIVE_CHAT_COMPOSER_PLACEHOLDER } from '../../../../../src/shared/native-chat-turn-status'
import { MobileNativeChatComposerMenu } from './MobileNativeChatComposerMenu'
import { MobileNativeChatComposerField } from './MobileNativeChatComposerField'
import { MobileNativeChatComposerAttachments } from './MobileNativeChatComposerAttachments'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import { ActionSheetModal } from '../../../components/ActionSheetModal'
import { mobileNativeChatAttachActions } from '../../mobile-native-chat-attach-actions'
import {
  MobileNativeChatSessionOptionPickers,
  type MobileNativeChatPickerPresentation,
  type MobileNativeChatSessionOptionPickersProps
} from '../input/MobileNativeChatSessionOptionPickers'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { MobileComposerStructuredCatalog } from './mobile-native-chat-composer-menu'
import { useMobileNativeChatComposerMenu } from './use-mobile-native-chat-composer-menu'
import { keepHeldPressThroughLongPress } from '../../held-press-long-press'
import { mobileNativeChatComposerShowsStop } from './mobile-native-chat-composer-layout'
import { MobileNativeChatStopButton } from '../input/MobileNativeChatStopButton'
import { mobileNativeChatComposerStyles as styles } from './mobile-native-chat-composer-styles'

const NO_FILE_PATHS: string[] = []
const NO_ATTACHMENTS: PendingNativeChatImage[] = []
const NO_FILES: PendingNativeChatFile[] = []

export type MobileNativeChatStructuredComposer = {
  catalog: MobileComposerStructuredCatalog
  onSlashMenuOpen: () => void
  onAttachFiles?: () => void
  // An uploading attachment must hold Send.
  files: readonly PendingNativeChatFile[]
  onRemoveFile: (id: string) => void
}

type Props = {
  insertDictation?: (text: string) => boolean | void
  draftScopeKey?: string | null
  editSession?: { cancel: () => void; refuseCommand: (text: string) => boolean; locked: boolean }
  onPickSkill?: (skill: { name: string; path: string }) => void
  inputRef?: React.RefObject<TextInput | null>
  // Terminal-backed chats keep curated commands and image-only attachment actions.
  structured?: MobileNativeChatStructuredComposer | null
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string) => Promise<boolean>
  /** Changes whenever the route focuses a different chat composer surface. */
  sendSurfaceId: string
  /** Reads the retained route's focus generation without forcing a screen render. */
  getSendCompletionGeneration: () => number
  getComposerEditGeneration: () => number
  agent?: string | null
  sessionOptions?: MobileNativeChatSessionOptionPickersProps | null
  onAttachImage?: () => void
  attachments?: PendingNativeChatImage[]
  onRemoveAttachment?: (id: string) => void
  isAttaching?: boolean
  onMicPress?: () => void
  micActive?: boolean
  dictationMode?: string
  onMicPressIn?: () => void
  onMicPressOut?: () => void
  disabled?: boolean
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
  dictationMode = 'toggle',
  onMicPressIn,
  onMicPressOut,
  disabled = false,
  sendDisabled = false,
  placeholder = NATIVE_CHAT_COMPOSER_PLACEHOLDER,
  filePaths = NO_FILE_PATHS,
  onNeedFiles,
  skillDiscovery,
  onNeedSkills,
  stop = null
}: Props): React.JSX.Element {
  useEffect(() => {
    if (!draftScopeKey) {
      return
    }
    return registerMobileNativeChatTextDestination(
      draftScopeKey,
      insertDictation ??
        ((text) =>
          setMobileNativeChatDraftText(draftScopeKey, (before) =>
            appendBufferedDictation(before, text)
          ))
    )
  }, [draftScopeKey, insertDictation])
  useMobileColorScheme()
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
    agent,
    structuredCatalog: structured?.catalog,
    filePaths,
    onNeedFiles,
    skillDiscovery,
    onNeedSkills,
    onSlashMenuOpen: structured?.onSlashMenuOpen,
    focusField: () => fieldRef.current?.focus()
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
  const showsStop = mobileNativeChatComposerShowsStop({
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

  const handleSend = async (): Promise<void> => {
    if (!canSend || sendingRef.current) {
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
      const accepted = await onSend(value)
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
  const attachLabel = structured ? 'Add to message' : 'Attach image'

  return (
    <View>
      {menu.rows.length > 0 ? (
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
            onRemoveImage={editSession?.locked ? undefined : onRemoveAttachment}
            onRemoveFile={editSession?.locked ? undefined : structured?.onRemoveFile}
          />
          <MobileNativeChatComposerField
            ref={fieldRef}
            value={value}
            skillToken={menu.skillToken}
            onChangeText={menu.onFieldChange}
            onFocus={() => {
              setFocused(true)
              if (draftScopeKey) {
                focusMobileNativeChatTextDestination(draftScopeKey)
              }
            }}
            onBlur={() => setFocused(false)}
            // Controlled only transiently right after an autocomplete insert.
            selection={menu.pendingSelection ?? undefined}
            onSelectionChange={(e) => menu.onSelectionChange(e.nativeEvent.selection)}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            selectionColor={colors.accentBlue}
            multiline
            editable={!editSession?.locked}
            // Why: never revoke `editable` — iOS resigns first responder on a focused
            // field, so a transient lock would yank the keyboard mid-typing (#10681).
            // The lock gates sending; the draft survives and rides the next send.
            textAlignVertical="top"
          />
          <View style={styles.actionRow} testID="native-chat-composer-actions">
            {attachPress ? (
              <Pressable
                accessibilityLabel={attachLabel}
                style={({ pressed }) => [styles.controlButton, pressed && styles.pressed]}
                onPress={attachPress}
                disabled={isAttaching || disabled}
              >
                {isAttaching ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : (
                  <Plus size={19} color={colors.textPrimary} strokeWidth={2} />
                )}
              </Pressable>
            ) : null}
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
            <View style={styles.actionSpacer} />
            {onMicPress ? (
              <Pressable
                accessibilityLabel={micActive ? 'Stop dictation' : 'Dictate'}
                style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
                // Hold mode is walkie-talkie (press-in/out); toggle mode taps.
                onPress={dictationMode === 'hold' ? undefined : onMicPress}
                onPressIn={dictationMode === 'hold' ? onMicPressIn : undefined}
                onPressOut={dictationMode === 'hold' ? onMicPressOut : undefined}
                onLongPress={dictationMode === 'hold' ? keepHeldPressThroughLongPress : undefined}
                disabled={disabled && !micActive}
              >
                {/* The icon swaps on press; as the page's touch target, its removal would send
                    touchend to a detached node and lose the release. */}
                {micActive ? (
                  <Square
                    pointerEvents="none"
                    size={16}
                    color={colors.statusRed}
                    strokeWidth={2.4}
                    fill={colors.statusRed}
                  />
                ) : (
                  <Mic
                    pointerEvents="none"
                    size={19}
                    color={colors.textSecondary}
                    strokeWidth={2}
                  />
                )}
              </Pressable>
            ) : null}
            {editSession ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel editing"
                style={styles.ghostButton}
                onPress={editSession.cancel}
              >
                <Text style={{ color: colors.textSecondary }}>Cancel</Text>
              </Pressable>
            ) : null}
            {showsStop && stop ? (
              // Only this phone's own request holds Stop: a repeat is how a stuck stop escalates.
              <MobileNativeChatStopButton onStop={stop.onStop} held={stop.held} />
            ) : (
              <Pressable
                accessibilityLabel={editSession ? 'Save edited message' : 'Send message'}
                style={({ pressed }) => [
                  styles.sendButton,
                  !canSend && styles.sendButtonDisabled,
                  pressed && canSend && styles.pressed
                ]}
                onPress={handleSend}
                disabled={!canSend}
              >
                {editSession ? (
                  <Text style={{ color: canSend ? colors.bgBase : colors.textMuted }}>Save</Text>
                ) : (
                  <ArrowUp
                    size={19}
                    color={canSend ? colors.bgBase : colors.textMuted}
                    strokeWidth={2.4}
                  />
                )}
              </Pressable>
            )}
          </View>
        </View>
      </View>
      {structured ? (
        <ActionSheetModal
          visible={attachOpen}
          onClose={() => setAttachOpen(false)}
          actions={mobileNativeChatAttachActions({
            onPhotos: onAttachImage,
            onFiles: structured.onAttachFiles,
            onWorkspaceFile: menu.openFileMenu,
            onSkills: () => menu.openSlashMenu('skill'),
            onCommands: () => menu.openSlashMenu('command'),
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
