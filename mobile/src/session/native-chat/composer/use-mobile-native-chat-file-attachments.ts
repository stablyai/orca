import { createNonSecureContextUuid as createUuidV4 } from '../../../../../src/shared/non-secure-context-uuid'
import {
  useMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs,
  mobileNativeChatDraftDestination,
  type MobileNativeChatDraftDestination
} from './mobile-native-chat-draft-inputs'
import { useCallback } from 'react'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { useMediaPicker } from '../../../platform/media-picker'
import type { PickedMobileFile } from '../../../platform/media-picker-contract'
import { encodeBase64Bytes } from '../../../transport/encryption/base64-byte-codec'
import { agentSessionPastedTextName } from '../../../../../src/shared/agent-session/agent-session-attachments'
import { uploadMobileAgentSessionAttachment } from '../../../files/attachments/mobile-agent-session-attachment-upload'
import {
  uploadPickedNativeChatFiles,
  type PendingNativeChatFile
} from './mobile-native-chat-file-attachment'

type ShowToast = (message: string, durationMs?: number) => void

export type MobileNativeChatFileAttachments = {
  readonly files: readonly PendingNativeChatFile[]
  readonly attachFiles: () => Promise<void>
  /** Stores a long paste as a "Pasted text" file, as desktop does; null when no upload can start. */
  readonly attachPastedText: ((text: string) => Promise<void>) | null
  // Drop only files removed or carried by this send; attachments added while sending must survive.
  readonly removeFiles: (
    ids: readonly string[],
    destination?: MobileNativeChatDraftDestination
  ) => void
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
  const files = useMobileNativeChatDraftInputs(scopeKey, 'files')

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

  const attach = useCallback(
    async (picked: () => AsyncIterable<PickedMobileFile>): Promise<void> => {
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
          picked: picked(),
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
    },
    [client, enabled, scopeKey, sessionId, showToast, updateScope]
  )
  const attachFiles = useCallback(() => attach(() => picker.pickFiles()), [attach, picker])
  const attachPastedText = useCallback(
    (text: string) =>
      attach(async function* () {
        const bytes = new TextEncoder().encode(text)
        yield {
          name: agentSessionPastedTextName(Date.now(), createUuidV4()),
          mime: 'text/plain',
          byteLength: bytes.byteLength,
          base64: encodeBase64Bytes(bytes)
        }
      }),
    [attach]
  )

  const removeFiles = useCallback(
    (ids: readonly string[], destination?: MobileNativeChatDraftDestination) => {
      const target = destination ?? scopeKey
      if (target) {
        const removed = new Set(ids)
        updateScope(target, (current) => current.filter((file) => !removed.has(file.id)))
      }
    },
    [scopeKey, updateScope]
  )

  const canAttach = Boolean(client && sessionId && scopeKey && enabled)
  return {
    files,
    attachFiles,
    attachPastedText: canAttach ? attachPastedText : null,
    removeFiles
  }
}
