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
import {
  agentSessionAttachmentAppends,
  agentSessionPastedTextName
} from '../../../../../src/shared/agent-session/agent-session-attachments'
import { uploadMobileAgentSessionAttachment } from '../../../files/attachments/mobile-agent-session-attachment-upload'
import { uploadMobileTerminalFile } from '../../../files/attachments/mobile-terminal-file-upload'
import {
  uploadPickedNativeChatFiles,
  type PendingNativeChatFile
} from './mobile-native-chat-file-attachment'

/** Where picked files are stored: a structured chat's own session, or the host running a terminal agent. */
export type MobileNativeChatFileTarget =
  | { readonly kind: 'structured'; readonly sessionId: string }
  | { readonly kind: 'terminal'; readonly getConnectionId: () => Promise<string | null> }

// Chips and `pending` live in the module-level draft store and outlive this hook, so the controllers
// that cancel their transfers must too (file ids are UUIDs, unique across scopes).
const transfers = new Map<string, AbortController>()

type ShowToast = (message: string, durationMs?: number) => void

export type MobileNativeChatFileAttachments = {
  readonly files: readonly PendingNativeChatFile[]
  readonly attachFiles: () => Promise<void>
  /** Stores a long paste as a "Pasted text" file, as desktop does; null when no upload can start. */
  readonly attachPastedText: ((text: string) => Promise<void>) | null
  /** True when a pick can start: connected, a storage target, a draft scope. Gates the + menu's Files entry. */
  readonly canAttachFiles: boolean
  // Drop only files removed or carried by this send; attachments added while sending must survive.
  readonly removeFiles: (
    ids: readonly string[],
    destination?: MobileNativeChatDraftDestination
  ) => void
}

export function useMobileNativeChatFileAttachments(args: {
  client: RpcClient | null
  target: MobileNativeChatFileTarget | null
  scopeKey: string | null
  enabled: boolean
  showToast: ShowToast
}): MobileNativeChatFileAttachments {
  const { client, target, scopeKey, enabled, showToast } = args

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
      if (!client || !target || !scope || !enabled) {
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
          upload: async (file, { id, onProgress: reportProgress }) => {
            const controller = new AbortController()
            transfers.set(id, controller)
            // A closed draft has no chip to fill: stop the transfer rather than commit a stray file.
            const onProgress = (sentBytes: number): void => {
              if (!destination.active) {
                controller.abort()
                return
              }
              reportProgress(sentBytes)
            }
            try {
              if (target.kind === 'structured') {
                return await uploadMobileAgentSessionAttachment(client, {
                  sessionId: target.sessionId,
                  file,
                  signal: controller.signal,
                  onProgress
                })
              }
              return await uploadMobileTerminalFile(client, {
                file,
                connectionId: await target.getConnectionId(),
                signal: controller.signal,
                onProgress
              })
            } finally {
              transfers.delete(id)
            }
          },
          nextId: createUuidV4,
          onPicked: (file) => updateScope(destination, (current) => [...current, file]),
          onProgress: (id, sentBytes) =>
            updateScope(destination, (current) =>
              current.map((file) => (file.id === id ? { ...file, sentBytes } : file))
            ),
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
    [client, enabled, scopeKey, showToast, target, updateScope]
  )
  const attachFiles = useCallback(() => attach(() => picker.pickFiles()), [attach, picker])
  // Pasted text stays a structured-chat feature: a terminal agent takes long pastes as typed text.
  const structuredOnly = target?.kind === 'structured'
  const attachPastedText = useCallback(
    (text: string) =>
      attach(async function* () {
        const bytes = new TextEncoder().encode(text)
        yield {
          name: agentSessionPastedTextName(Date.now(), createUuidV4()),
          mime: 'text/plain',
          byteLength: bytes.byteLength,
          chunks: async function* () {
            for (const append of agentSessionAttachmentAppends(encodeBase64Bytes(bytes))) {
              yield append.contentBase64
            }
          }
        }
      }),
    [attach]
  )

  const removeFiles = useCallback(
    (ids: readonly string[], destination?: MobileNativeChatDraftDestination) => {
      const scope = destination ?? scopeKey
      if (scope) {
        const removed = new Set(ids)
        for (const id of removed) {
          transfers.get(id)?.abort()
        }
        updateScope(scope, (current) => current.filter((file) => !removed.has(file.id)))
      }
    },
    [scopeKey, updateScope]
  )

  const canAttach = Boolean(client && target && scopeKey && enabled)
  return {
    files,
    attachFiles,
    canAttachFiles: canAttach,
    attachPastedText: canAttach && structuredOnly ? attachPastedText : null,
    removeFiles
  }
}
