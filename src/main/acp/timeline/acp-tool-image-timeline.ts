import { buildImageDataUri } from '../../../shared/file-preview/image-data-uri'
import type { NativeChatImageRefBlock } from '../../../shared/native-chat/native-chat-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'

/** Content replaces the snapshot; an omitted field leaves the tool's images alone. */
export function acpToolOutputImages(update: ToolCallUpdate): NativeChatImageRefBlock[] | undefined {
  if (update.content == null) {
    return undefined
  }
  return update.content.flatMap((part): NativeChatImageRefBlock[] => {
    if (part.type !== 'content' || part.content.type !== 'image') {
      return []
    }
    const data = part.content.data.replace(/\s/g, '')
    const url =
      data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)
        ? buildImageDataUri(part.content.mimeType, data)
        : null
    return url
      ? [{ type: 'image-ref', url }]
      : [{ type: 'image-ref', alt: 'Image preview unavailable' }]
  })
}
