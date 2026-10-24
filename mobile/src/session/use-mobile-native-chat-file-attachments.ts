import {
  captureMobileChatDraftOwner,
  resolveMobileChatDraftSendOwner,
  mobileChatDraftOwnerLive
} from './mobile-native-chat-draft-store'
import {
  onMobileChatDraftRemoval,
  subscribeMobileChatDraftStorage
} from './mobile-native-chat-draft-storage'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { useMediaPicker } from '../platform/media-picker'
import { uploadMobileAgentSessionAttachment } from './mobile-agent-session-attachment-upload'
import { withScopeAttachments } from './mobile-native-chat-image-scope-state'
import {
  uploadPickedNativeChatFiles,
  type PendingNativeChatFile
} from './mobile-native-chat-file-attachment'

type ShowToast = (message: string, durationMs?: number) => void
type FilesByScope = Readonly<Record<string, readonly PendingNativeChatFile[]>>

const NO_FILES: readonly PendingNativeChatFile[] = []

export type MobileNativeChatFileAttachments = {
  /** Files for the active scope (tab) only. */
  readonly files: readonly PendingNativeChatFile[]
  readonly attachFiles: () => Promise<void>
  /** Drops these files: a removed card, or the files a send carried (one attached while it was in
   *  flight stays). */
  readonly removeFiles: (ids: readonly string[]) => void
  readonly consumeSubmittedFiles: (ids: readonly string[]) => void
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
  const [filesByScope, setFilesByScope] = useState<FilesByScope>({})
  const picker = useMediaPicker()
  const idCounter = useRef(0)
  const owner = scopeKey ? captureMobileChatDraftOwner(scopeKey) : undefined
  useEffect(
    () =>
      onMobileChatDraftRemoval((host, workspace) => {
        setFilesByScope((prev) =>
          Object.fromEntries(
            Object.entries(prev).filter(([scope]) => {
              const [h, w] = scope.split('\0')
              return h !== host || (workspace !== undefined && workspace !== w)
            })
          )
        )
      }),
    []
  )
  useEffect(
    () =>
      subscribeMobileChatDraftStorage(() => {
        setFilesByScope((prev) =>
          Object.fromEntries(
            Object.entries(prev).map(([scope, files]) => [
              scope,
              files.filter((file) => file.path !== null)
            ])
          )
        )
      }),
    []
  )
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
    const owner = scope ? captureMobileChatDraftOwner(scope) : undefined
    if (!client || !sessionId || !scope || !owner || owner.state === 'unread' || !enabled) {
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
      onPicked: (file) =>
        mobileChatDraftOwnerLive(owner) && updateScope(scope, (current) => [...current, file]),
      onStored: (id, stored) => {
        if (!mobileChatDraftOwnerLive(owner)) {
          throw new Error('This draft session has ended')
        }
        updateScope(scope, (current) =>
          current.map((file) =>
            file.id === id ? { ...file, name: stored.name, path: stored.path } : file
          )
        )
      },
      onFailed: (id) =>
        mobileChatDraftOwnerLive(owner) &&
        updateScope(scope, (current) => current.filter((file) => file.id !== id)),
      onError: (message) => showToast(message)
    })
  }, [client, enabled, picker, scopeKey, sessionId, showToast, updateScope])

  const removeFiles = useCallback(
    (ids: readonly string[]) => {
      if (scopeKey && owner && owner.state !== 'unread' && mobileChatDraftOwnerLive(owner)) {
        const removed = new Set(ids)
        updateScope(scopeKey, (current) => current.filter((file) => !removed.has(file.id)))
      }
    },
    [scopeKey, owner, updateScope]
  )

  const consumeSubmittedFiles = useCallback(
    (ids: readonly string[]) => {
      const target = resolveMobileChatDraftSendOwner(owner)
      if (target) {
        const removed = new Set(ids)
        updateScope(target.scope, (current) => current.filter((file) => !removed.has(file.id)))
      }
    },
    [owner, updateScope]
  )

  return { files, attachFiles, removeFiles, consumeSubmittedFiles }
}
