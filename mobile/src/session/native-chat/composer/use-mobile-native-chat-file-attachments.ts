import { createUuidV4 } from '../../../../../src/shared/uuid-v4'
import {
  useMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs,
  mobileNativeChatDraftDestination,
  type MobileNativeChatDraftDestination
} from './mobile-native-chat-draft-inputs'
import { useCallback } from 'react'
import type { RpcClient } from '../../../transport/rpc-client'
import { useMediaPicker } from '../../../platform/media-picker'
import { uploadMobileAgentSessionAttachment } from '../../mobile-agent-session-attachment-upload'
import {
  uploadPickedNativeChatFiles,
  type PendingNativeChatFile
} from './mobile-native-chat-file-attachment'

type ShowToast = (message: string, durationMs?: number) => void

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

  const picker = useMediaPicker()
  const files = useMobileNativeChatDraftInputs(scopeKey).files

  const updateScope = useCallback(
    (
      scope: string | MobileNativeChatDraftDestination,
      next: (current: readonly PendingNativeChatFile[]) => readonly PendingNativeChatFile[]
    ) =>
      updateMobileNativeChatDraftInputs(scope, (current) => ({
        ...current,
        files: next(current.files)
      })),
    []
  )

  const attachFiles = useCallback(async (): Promise<void> => {
    const scope = scopeKey
    if (!client || !sessionId || !scope || !enabled) {
      return
    }
    const destination = mobileNativeChatDraftDestination(scope)
    updateMobileNativeChatDraftInputs(destination, (current) => ({
      ...current,
      pending: (current.pending ?? 0) + 1
    }))
    try {
      await uploadPickedNativeChatFiles({
        canContinue: () => destination.active,
        picked: picker.pickFiles(),
        upload: (file) =>
          uploadMobileAgentSessionAttachment(client, {
            sessionId,
            name: file.name,
            base64: file.base64
          }),
        nextId: createUuidV4,
        onPicked: (file) => updateScope(destination, (current) => [...current, file]),
        onStored: (id, stored) =>
          updateScope(destination, (current) =>
            current.map((file) =>
              file.id === id ? { ...file, name: stored.name, path: stored.path } : file
            )
          ),
        onFailed: (id) =>
          updateScope(destination, (current) => current.filter((file) => file.id !== id)),
        onError: (message) => {
          if (destination.active) {
            showToast(message)
          }
        }
      })
    } finally {
      updateMobileNativeChatDraftInputs(destination, (current) => ({
        ...current,
        pending: Math.max(0, (current.pending ?? 0) - 1)
      }))
    }
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
