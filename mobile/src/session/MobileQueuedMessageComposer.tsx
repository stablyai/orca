import { useContext, useEffect, useMemo, useRef } from 'react'
import { MobileQueuedMessageComposerContext } from './mobile-queued-message-composer-context'
import { Text, type TextInput, View } from 'react-native'
import { MobileNativeChatComposer } from './native-chat/composer/MobileNativeChatComposer'
import type { MobileQueuedMessageInlineEditor } from './use-mobile-structured-queued-edit'
import { useMobileNativeChatFileAttachments } from './native-chat/composer/use-mobile-native-chat-file-attachments'
import { useMobileNativeChatImageUpload } from './native-chat/composer/use-mobile-native-chat-image-upload'
import {
  updateMobileNativeChatDraftInputs,
  useMobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { prepareQueuedMessageEditText } from '../../../src/shared/queued-message-edit-command'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { createUuidV4 } from '../../../src/shared/uuid-v4'

export function MobileQueuedMessageComposer({
  editor,
  attribution
}: {
  editor: MobileQueuedMessageInlineEditor
  attribution: string | null
}): React.JSX.Element {
  useMobileColorScheme()
  const context = useContext(MobileQueuedMessageComposerContext)
  const inputRef = useRef<TextInput>(null)
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
  const acceptsText = useMemo(
    () => prepareQueuedMessageEditText(agent, reported),
    [agent, reported]
  )
  const refuseCommand = (text: string): boolean => {
    if (acceptsText(text)) {
      return false
    }
    context?.onError("Commands can't be saved in a queued message.")
    return true
  }
  return (
    <View testID="queued-card-editor">
      <Text style={{ color: colors.textMuted }}>
        Editing message{attribution ? ` · ${attribution}` : ''}
      </Text>
      <MobileNativeChatComposer
        inputRef={inputRef}
        draftScopeKey={editor.scopeKey}
        insertDictation={editor.insertDictation}
        agent={context?.agent}
        value={editor.text}
        onChangeText={editor.change}
        onSend={() => editor.save()}
        editSession={{ cancel: editor.cancel, locked: editor.saving, refuseCommand }}
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
        isAttaching={images.isAttaching}
        onMicPress={context?.onMicPress}
        micActive={context?.micActive}
        micProcessing={context?.micProcessing}
        dictationMode={context?.dictationMode}
        onMicPressIn={context?.onMicPressIn}
        onMicPressOut={context?.onMicPressOut}
      />
    </View>
  )
}
