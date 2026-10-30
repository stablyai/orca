import { createUuidV4 } from '../../../../../src/shared/uuid-v4'
import { useCallback } from 'react'
import type { RpcClient } from '../../../transport/rpc-client'
import { useMediaPicker } from '../../../platform/media-picker'
import { saveMobileClipboardImageAsTempFile } from '../../mobile-clipboard-image'
import {
  mobileNativeChatDraftDestination,
  updateMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'
import { setMobileNativeChatDraftText } from './mobile-native-chat-draft-store'
import {
  nativeChatDraftWithFile,
  uploadPickedNativeChatFiles
} from './mobile-native-chat-file-attachment'

type ShowToast = (message: string, durationMs?: number) => void

const NOOP = (): void => {}
// A desktop older than picked-file names saves any bytes under this name, and an agent then reads a PDF as a broken image.
const HOST_DROPPED_NAME_RE = /(^|[\\/])orca-paste-\d+-[^\\/]+\.png$/i

// A terminal has no attachment store, so the file goes up like a terminal paste and its path joins the draft.
export function useMobileNativeChatTerminalFileAttachments(args: {
  client: RpcClient | null
  scopeKey: string | null
  enabled: boolean
  getConnectionId: () => Promise<string | null>
  showToast: ShowToast
}): () => Promise<void> {
  const { client, scopeKey, enabled, getConnectionId, showToast } = args
  const picker = useMediaPicker()

  return useCallback(async (): Promise<void> => {
    if (!client || !scopeKey || !enabled) {
      return
    }
    // Follow the chat that asked: a tab switch mid-upload must not move the path to another draft.
    const destination = mobileNativeChatDraftDestination(scopeKey)
    updateMobileNativeChatDraftInputs(destination, (current) => ({
      ...current,
      pending: (current.pending ?? 0) + 1
    }))
    try {
      await uploadPickedNativeChatFiles({
        canContinue: () => destination.active,
        picked: picker.pickFiles(),
        upload: async (file) => {
          const path = await saveMobileClipboardImageAsTempFile(client, file.base64, {
            connectionId: await getConnectionId(),
            fileName: file.name
          })
          if (HOST_DROPPED_NAME_RE.test(path)) {
            throw new Error('The host did not keep the file name')
          }
          return { path, name: file.name, byteLength: file.byteLength }
        },
        nextId: createUuidV4,
        onPicked: NOOP,
        onStored: (_id, stored) =>
          setMobileNativeChatDraftText(destination, (draft) =>
            nativeChatDraftWithFile(draft, stored.path)
          ),
        onFailed: NOOP,
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
  }, [client, enabled, getConnectionId, picker, scopeKey, showToast])
}
