import { useContext, useEffect, useMemo, useRef } from 'react'
import { MobileQueuedMessageComposerContext } from './mobile-queued-message-composer-context'
import { Text, View, type TextInputInstance } from 'react-native'
import { MobileNativeChatComposer } from '../composer/MobileNativeChatComposer'
import type { MobileQueuedMessageInlineEditor } from './mobile-queued-message-edit-draft'
import { useMobileNativeChatFileAttachments } from '../composer/use-mobile-native-chat-file-attachments'
import { useMobileNativeChatImageUpload } from '../composer/use-mobile-native-chat-image-upload'
import {
  updateMobileNativeChatDraftInputs,
  useMobileNativeChatDraftInputs
} from '../composer/mobile-native-chat-draft-inputs'
import { prepareQueuedMessageEditText } from '../../../../../src/shared/queued-message-edit-command'
import type { AgentMessageSource } from '../../../../../src/shared/agent-session/agent-session-message-source'
import { MobileAgentMessageSenders } from '../transcript/MobileAgentMessageSenders'
import { queuedMessageStyles as styles } from './mobile-native-chat-queued-message-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { createNonSecureContextUuid as createUuidV4 } from '../../../../../src/shared/non-secure-context-uuid'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'

export function MobileQueuedMessageComposer({
  editor,
  from
}: {
  editor: MobileQueuedMessageInlineEditor
  from: AgentMessageSource | undefined
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const context = useContext(MobileQueuedMessageComposerContext)
  const inputRef = useRef<TextInputInstance>(null)
  const emptyHandle = useRef<string | null>(null)
  const inputs = useMobileNativeChatDraftInputs(editor.scopeKey)
  const files = useMobileNativeChatFileAttachments({
    client: editor.client,
    sessionId: editor.sessionId,
    scopeKey: editor.scopeKey,
    enabled: !editor.saving,
    showToast: (message) => context?.onError(message)
  })
  const images = useMobileNativeChatImageUpload({
    client: editor.client,
    activeHandleRef: emptyHandle,
    getActiveWorktreeConnectionId: async () => null,
    connState: 'connected',
    scopeKey: editor.scopeKey,
    structuredNativeChat: true,
    showToast: (message) => context?.onError(message),
    onImagesUploaded: (scope, images) =>
      updateMobileNativeChatDraftInputs(scope, (current) => ({
        ...current,
        images: [...current.images, ...images.map((image) => ({ ...image, id: createUuidV4() }))]
      }))
  })
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const agent = context?.agent ?? 'codex'
  const reported = context?.structured?.catalog.reported
  // As on desktop, a host-set goal is an action, not text a queued message can hold.
  const hostSetsGoals = context?.structured?.threadGoal?.changes === 'host'
  const acceptsText = useMemo(
    () =>
      prepareQueuedMessageEditText(
        agent,
        reported,
        hostSetsGoals,
        context?.interactionModeSupported === true,
        context?.structured?.catalog.conversationCommands,
        context?.structured?.catalog.cleanBackgroundTerminals
      ),
    [
      agent,
      reported,
      hostSetsGoals,
      context?.interactionModeSupported,
      context?.structured?.catalog
    ]
  )
  const refuseCommand = (text: string): boolean => {
    if (acceptsText(text)) {
      return false
    }
    context?.onError(
      t(
        'session.queuedMessageComposer.commandsNotAllowed',
        "Commands can't be saved in a queued message."
      )
    )
    return true
  }
  return (
    <View testID="queued-card-editor">
      <View style={styles.editorHeading}>
        <Text style={styles.caption}>
          {t('session.queuedMessageComposer.editing', 'Editing message')}
        </Text>
        {from ? <MobileAgentMessageSenders queued from={from} /> : null}
      </View>
      <MobileNativeChatComposer
        inputRef={inputRef}
        draftScopeKey={editor.scopeKey}
        insertDictation={editor.insertDictation}
        agent={context?.agent}
        value={editor.text}
        onChangeText={editor.change}
        onSend={() => editor.save()}
        editSession={{
          cancel: editor.cancel,
          locked: editor.saving,
          refuseCommand,
          interactionModeSupported: context?.interactionModeSupported
        }}
        sendSurfaceId={editor.scopeKey}
        getSendCompletionGeneration={() => 0}
        getComposerEditGeneration={() => 0}
        disabled={editor.saving}
        sendDisabled={!editor.canSave}
        structured={
          context?.structured
            ? {
                ...context.structured,
                files: files.files,
                onAttachFiles: () => void files.attachFiles(),
                onAttachPastedText: context.structured.onAttachPastedText
                  ? (files.attachPastedText ?? undefined)
                  : undefined,
                onRemoveFile: (id) => files.removeFiles([id])
              }
            : null
        }
        skillDiscovery={context?.skillDiscovery}
        onNeedSkills={context?.onNeedSkills}
        filePaths={context?.filePaths}
        onNeedFiles={context?.onNeedFiles}
        onPickSkill={(skill) =>
          updateMobileNativeChatDraftInputs(editor.scopeKey, (current) => ({
            ...current,
            skills: [...current.skills.filter(({ name }) => name !== skill.name), skill]
          }))
        }
        attachments={[...inputs.images]}
        onRemoveAttachment={editor.imagesCapable ? editor.removeImage : undefined}
        onAttachImage={
          editor.imagesCapable
            ? () => {
                void images.attachImage('library')
              }
            : undefined
        }
        onPasteImages={editor.imagesCapable ? (paste) => void images.attachImage(paste) : undefined}
        isAttaching={images.isAttaching}
        onMicPress={context?.onMicPress}
        micActive={context?.micActive}
        micStarting={context?.micStarting}
        micProcessing={context?.micProcessing}
        dictationMode={context?.dictationMode}
        onMicPressIn={context?.onMicPressIn}
        onMicPressOut={context?.onMicPressOut}
      />
    </View>
  )
}
