import { useEffect } from 'react'
import { subscribeMirroredKey } from '../storage/mirrored-storage-keys'
import { DUO_CHAT_EXPANDED_KEY } from '../session/duo-chat-width'

/** Push a chat-width change to every other open session page. */
export function useDuoChatWidthPublish(publish: () => void): void {
  useEffect(() => subscribeMirroredKey(DUO_CHAT_EXPANDED_KEY, () => publish()), [publish])
}
