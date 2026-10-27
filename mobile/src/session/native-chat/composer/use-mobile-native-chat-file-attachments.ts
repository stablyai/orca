import { useCallback, useRef, useState } from 'react'
import type { RpcClient } from '../../../transport/rpc-client'
import { useMediaPicker } from '../../../platform/media-picker'
import { uploadMobileAgentSessionAttachment } from '../../mobile-agent-session-attachment-upload'
import { withScopeAttachments } from './mobile-native-chat-image-scope-state'
import {
  uploadPickedNativeChatFiles,
  type PendingNativeChatFile
} from './mobile-native-chat-file-attachment'

type ShowToast = (message: string, durationMs?: number) => void
type FilesByScope = Readonly<Record<string, readonly PendingNativeChatFile[]>>

const NO_FILES: readonly PendingNativeChatFile[] = []

export type MobileNativeChatFileAttachments = {
  readonly files: readonly PendingNativeChatFile[]
  readonly attachFiles: () => Promise<void>
  // Drop only files removed or carried by this send; attachments added while sending must survive.
  readonly removeFiles: (ids: readonly string[]) => void
}

export function useMobileNativeChatFileAttachments(args: {
  client: RpcClient | null
  sessionId: string | null
  scopeKey: string | null
  enabled: boolean
  showToast: ShowToast
}): MobileNativeChatFileAttachments {
  const { client, sessionId, scopeKey, enabled, showToast } = args
  const [filesByScope, setFilesByScope] = useState<FilesByScope>({})
  const picker = useMediaPicker()
  const idCounter = useRef(0)
  const files = (scopeKey ? filesByScope[scopeKey] : undefined) ?? NO_FILES

  const updateScope = useCallback(
    (
      scope: string,
      next: (current: readonly PendingNativeChatFile[]) => readonly PendingNativeChatFile[]
    ) =>
      setFilesByScope((prev) => withScopeAttachments(prev, scope, next(prev[scope] ?? NO_FILES))),
    []
  )

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
        idCounter.current += 1
        return `file-${idCounter.current}`
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
