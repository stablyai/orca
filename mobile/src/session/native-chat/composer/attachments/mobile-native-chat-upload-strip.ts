import { useMemo } from 'react'
import {
  removeMobileNativeChatDraftImages,
  updateMobileNativeChatDraftInputs,
  useMobileNativeChatDraftInputs,
  type MobileNativeChatDraftInputs
} from '../drafts/mobile-native-chat-draft-inputs'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'

function withoutUpload(
  inputs: MobileNativeChatDraftInputs,
  id: string
): MobileNativeChatDraftInputs {
  if (inputs.uploads?.[id] === undefined) {
    return inputs
  }
  const { [id]: _cancelled, ...rest } = inputs.uploads
  return { ...inputs, uploads: rest }
}

/** Finished chips plus the files still streaming, which show their progress but are never sent or saved. */
export function useNativeChatStripAttachments(
  scopeKey: string | null,
  images: readonly PendingNativeChatImage[]
): PendingNativeChatImage[] {
  const uploads = useMobileNativeChatDraftInputs(scopeKey, 'uploads')
  return useMemo(
    () => [
      ...images,
      ...Object.entries(uploads ?? {}).map(([id, upload]) => ({
        id,
        path: '',
        previewUri: '',
        upload
      }))
    ],
    [images, uploads]
  )
}

/** Removing an uploading chip drops it here; the transfer sees it gone before its next chunk and stops. */
export function removeNativeChatStripAttachment(scope: string, id: string): void {
  removeMobileNativeChatDraftImages(scope, [id])
  updateMobileNativeChatDraftInputs(scope, (inputs) => withoutUpload(inputs, id))
}
