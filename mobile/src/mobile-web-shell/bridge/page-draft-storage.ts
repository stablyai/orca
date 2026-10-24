import { mobileChatDraftLifecycle } from '../../session/mobile-native-chat-draft-store'
import type { BridgeRpcClient } from './bridge-rpc-client'
import { BRIDGE_CHAT_DRAFT_STORAGE_GRANT, storageReadResultSchema } from './bridge-native-verbs'
import { draftWriteResultSchema } from './bridge-draft-storage'
import {
  MOBILE_CHAT_DRAFT_CHUNK_CHARS,
  mobileChatDraftStorageKey
} from '../../session/mobile-native-chat-draft-data'
import { publishMobileChatDraftStorage } from '../../session/mobile-native-chat-draft-storage'

export function installPageChatDraftStorage(client: BridgeRpcClient): void {
  const grants = client.getShellSession()?.grants.native ?? []
  if (
    !grants.includes(BRIDGE_CHAT_DRAFT_STORAGE_GRANT) &&
    (!grants.includes('native.storage.write') || !grants.includes('native.storage.read'))
  ) {
    publishMobileChatDraftStorage(null)
    return
  }
  const write = async (key: string, value: string | null): Promise<void> => {
    const writeId = `${Date.now()}-${Math.random()}`
    const total = Math.max(1, Math.ceil((value?.length ?? 0) / MOBILE_CHAT_DRAFT_CHUNK_CHARS))
    for (let index = 0; index < total; index++) {
      const result = draftWriteResultSchema.parse(
        (
          await client.callNativeVerb('native.storage.write', {
            key,
            writeId,
            index,
            total,
            value:
              value === null
                ? null
                : value.slice(
                    index * MOBILE_CHAT_DRAFT_CHUNK_CHARS,
                    (index + 1) * MOBILE_CHAT_DRAFT_CHUNK_CHARS
                  )
          })
        ).result
      )
      if (result.committed !== (index + 1 === total)) {
        throw new Error('Draft storage did not commit')
      }
    }
  }
  const visibility = () => mobileChatDraftLifecycle(document.visibilityState === 'visible')
  const hidden = () => mobileChatDraftLifecycle(false)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', hidden)
  }
  const retired = client.onRuntimeRetired?.((closed) => {
    publishMobileChatDraftStorage(null)
    if (!closed) {
      queueMicrotask(() => installPageChatDraftStorage(client))
    }
  })
  publishMobileChatDraftStorage({
    dispose: () => {
      hidden()
      retired?.()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', visibility)
        window.removeEventListener('pagehide', hidden)
      }
    },
    read: async (key) =>
      storageReadResultSchema.parse(
        (await client.callNativeVerb('native.storage.read', { key })).result
      ).value,
    write,
    removeWorkspace: async (hostId, workspaceId) => {
      if (workspaceId !== undefined) {
        await write(mobileChatDraftStorageKey(`${hostId}\0${workspaceId}\0`), null)
      }
    }
  })
}
