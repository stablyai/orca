import {
  useMobileDraftAttachments,
  nextMobileDraftAttachmentId
} from './mobile-native-chat-draft-store'
import { useCallback } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { useMediaPicker } from '../platform/media-picker'
import { uploadMobileAgentSessionAttachment } from './mobile-agent-session-attachment-upload'
import {
  uploadPickedNativeChatFiles,
  type PendingNativeChatFile
} from './mobile-native-chat-file-attachment'

type ShowToast = (message: string, durationMs?: number) => void

export type MobileNativeChatFileAttachments = {
  /** Files for the active scope (tab) only. */
  readonly files: readonly PendingNativeChatFile[]
  readonly attachFiles: () => Promise<void>
  /** Drops these files: a removed card, or the files a send carried (one attached while it was in
   *  flight stays). */
  readonly removeFiles: (ids: readonly string[]) => void
}

/** Files attached to a structured chat, uploaded into the host's attachment store on pick. */
export function useMobileNativeChatFileAttachments(args: {
  client: RpcClient | null
  sessionId: string | null
  /** The composer surface the files belong to, so a tab switch never carries them over. */
  scopeKey: string | null
  enabled: boolean
  showToast: ShowToast
}): MobileNativeChatFileAttachments {
  const { client, sessionId, scopeKey, enabled, showToast } = args
  const [files, updateScope] = useMobileDraftAttachments(scopeKey, 'files')
  const picker = useMediaPicker()
  const attachFiles = useCallback(async (): Promise<void> => {
    const scope = scopeKey
    if (!client || !sessionId || !scope || !enabled) {
      return
    }
    await uploadPickedNativeChatFiles({
      picked: picker.pickFiles(),
      upload: (file) =>
        uploadMobileAgentSessionAttachment(client, {
          sessionId,
          name: file.name,
          base64: file.base64
        }),
      nextId: () => {
        return nextMobileDraftAttachmentId('file')
      },
      onPicked: (file) => updateScope(scope, (current) => [...current, file]),
      onStored: (id, stored) =>
        updateScope(scope, (current) =>
          current.map((file) =>
            file.id === id ? { ...file, name: stored.name, path: stored.path } : file
          )
        ),
      onFailed: (id) => updateScope(scope, (current) => current.filter((file) => file.id !== id)),
      onError: (message) => showToast(message)
    })
  }, [client, enabled, picker, scopeKey, sessionId, showToast, updateScope])

  const removeFiles = useCallback(
    (ids: readonly string[]) => {
      if (scopeKey) {
        const removed = new Set(ids)
        updateScope(scopeKey, (current) => current.filter((file) => !removed.has(file.id)))
      }
    },
    [scopeKey, updateScope]
  )

  return { files, attachFiles, removeFiles }
}
