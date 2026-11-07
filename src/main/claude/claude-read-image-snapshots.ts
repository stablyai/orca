// Read-tool thumbnails otherwise load the source file, which the agent may delete before the chat is reopened.

import {
  AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  base64DecodedByteLength
} from '../../shared/agent-session/agent-session-attachments'
import { IMAGE_FILE_MIME_TYPES } from '../../shared/image-file-extensions'
import { nativeChatToolImageReadPath } from '../../shared/native-chat/tools/native-chat-tool-viewed-images'
import { getAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type {
  ClaudeToolResult,
  ClaudeToolUse
} from './structured/journal/claude-structured-item-translation'

/** The read file's name, with the extension of the bytes Claude actually returned. */
function snapshotName(readPath: string, mediaType: string): string | null {
  const extensions = Object.keys(IMAGE_FILE_MIME_TYPES).filter(
    (extension) => IMAGE_FILE_MIME_TYPES[extension] === mediaType
  )
  if (extensions.length === 0) {
    return null
  }
  const leaf = readPath.split(/[\\/]/).findLast(Boolean) ?? 'image'
  const dot = leaf.lastIndexOf('.')
  const extension = dot > 0 ? leaf.slice(dot).toLowerCase() : ''
  return extensions.includes(extension)
    ? leaf
    : `${dot > 0 ? leaf.slice(0, dot) : leaf}${extensions[0]}`
}

/** Store paths of the images a successful image read returned; empty leaves readers on the input path. */
export function snapshotClaudeReadImages(tool: ClaudeToolUse, result: ClaudeToolResult): string[] {
  const store = getAgentSessionAttachmentStore()
  const readPath = nativeChatToolImageReadPath(tool)
  if (!store || readPath === null || result.failed || result.images.length === 0) {
    return []
  }
  const paths: string[] = []
  for (const image of result.images) {
    const name = snapshotName(readPath, image.mediaType)
    if (!name || base64DecodedByteLength(image.data) > AGENT_SESSION_ATTACHMENT_MAX_BYTES) {
      continue
    }
    try {
      paths.push(store.storeSnapshotSync(name, Buffer.from(image.data, 'base64')))
    } catch (error) {
      console.warn('[claude-read-image-snapshots] snapshot skipped:', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return paths
}
