import type { NativeChatImageRefBlock } from '../../../../../shared/native-chat/native-chat-types'
import { isInlineDataUrl } from '../../../../../shared/native-chat/native-chat-inline-data-url'

// Image refs are labels over RPC; inline bytes stay local and metadata cannot consume the frame.
const NATIVE_CHAT_RPC_IMAGE_METADATA_CAP = 512

export function sanitizeNativeChatRpcImageBlock(
  block: NativeChatImageRefBlock
): NativeChatImageRefBlock {
  const path = boundedImageMetadata(block.path)
  const boundedUrl = boundedImageMetadata(block.url)
  const url = boundedUrl && !isInlineDataUrl(boundedUrl) ? boundedUrl : undefined
  const alt = boundedImageMetadata(block.alt)
  return {
    type: 'image-ref',
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    ...(alt ? { alt } : {})
  }
}

function boundedImageMetadata(value: string | undefined): string | undefined {
  return value && value.length <= NATIVE_CHAT_RPC_IMAGE_METADATA_CAP ? value : undefined
}
