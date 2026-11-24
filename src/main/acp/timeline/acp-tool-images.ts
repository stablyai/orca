// Tool-returned pixels live once in the attachment store; the journal and wire carry only their paths.

import {
  AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT,
  AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES,
  base64DecodedByteLength
} from '../../../shared/agent-session/agent-session-attachments'
import { assertRasterImagePreviewWithinLimits } from '../../../shared/file-preview/raster-image-preview-limits'
import { getAgentSessionAttachmentStore } from '../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { LOCAL_PREVIEWABLE_BINARY_MAX_BYTES } from '../../runtime/files/file-preview-budget'
import type { ToolCallContent } from '../generated/acp-protocol.generated'

// Raster only: SVG is script-capable markup, not a picture tile.
const RASTER_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp']
])

function storeToolImage(mimeType: string, data: string): string | null {
  const type = mimeType.split(';')[0]!.trim().toLowerCase()
  const extension = RASTER_EXTENSIONS.get(type)
  const store = getAgentSessionAttachmentStore()
  if (!extension || !store || base64DecodedByteLength(data) > LOCAL_PREVIEWABLE_BINARY_MAX_BYTES) {
    return null
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0 || bytes.length > LOCAL_PREVIEWABLE_BINARY_MAX_BYTES) {
    return null
  }
  try {
    // Agent bytes are untrusted: refuse non-images and decode bombs before any client draws them.
    assertRasterImagePreviewWithinLimits(bytes, type)
    return store.storeContent(bytes, extension)
  } catch {
    return null
  }
}

/** Store paths of the images a content snapshot holds; the store dedupes re-sent bytes. */
export function acpToolImagePaths(content: readonly ToolCallContent[]): string[] {
  const paths: string[] = []
  let images = 0
  let total = 0
  for (const part of content) {
    if (part.type !== 'content' || part.content.type !== 'image') {
      continue
    }
    const { data, mimeType } = part.content
    total += base64DecodedByteLength(data)
    if (
      ++images > AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT ||
      total > AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES
    ) {
      break
    }
    const path = storeToolImage(mimeType, data)
    if (path) {
      paths.push(path)
    }
  }
  return paths
}
