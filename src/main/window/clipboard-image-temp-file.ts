import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { getAppEnvironment } from '../../shared/app-environment'
import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'
import type { AgentSessionAttachmentClipboardTarget } from '../../shared/agent-session-attachments'
import { nativeChatPasteFolder } from './native-chat-paste-files'

export type SaveClipboardImageAsTempFileArgs = {
  connectionId?: string | null
  fileName?: string | null
  runtimeEnvironmentId?: string | null
  /** With `runtimeEnvironmentId`: store the image as an attachment of this structured chat. */
  agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
  /** A native-chat composer paste: kept in Orca's paste folder so its draft can bring it back. */
  forNativeChatDraft?: boolean
  /** With `forNativeChatDraft`: a structured chat on this machine, whose sends claim its pastes
   *  from this machine's chat attachment store. */
  forStructuredChat?: boolean
}

const MAX_TEMP_FILE_NAME_BYTES = 255

function sliceUtf8ByBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return ''
  }
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value
  }
  let result = ''
  let usedBytes = 0
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (usedBytes + charBytes > maxBytes) {
      break
    }
    result += char
    usedBytes += charBytes
  }
  return result
}

function sanitizeTempAttachmentFileName(
  rawName: string | null | undefined,
  maxBytes: number
): string | null {
  if (!rawName || maxBytes <= 0) {
    return null
  }
  const baseName = rawName.trim().split(/[/\\]/).pop() ?? ''
  const cleaned = baseName.replace(/[\p{Cc}<>:"/\\|?*]+/gu, '_').replace(/^[.\s]+|[.\s]+$/g, '')
  if (!cleaned) {
    return null
  }
  const ext = path.posix.extname(cleaned)
  const stem = ext ? cleaned.slice(0, -ext.length) : cleaned
  if (!stem) {
    return null
  }
  const boundedStem = sliceUtf8ByBytes(stem, maxBytes - Buffer.byteLength(ext, 'utf8'))
  if (!boundedStem) {
    return sliceUtf8ByBytes(stem, maxBytes) || null
  }
  return `${boundedStem}${ext}`
}

export async function saveClipboardImageBufferAsTempFile(
  buffer: Buffer,
  args?: SaveClipboardImageAsTempFileArgs
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)

  const prefix = `orca-paste-${Date.now()}-${randomUUID()}`
  const maxSanitizedBytes = MAX_TEMP_FILE_NAME_BYTES - Buffer.byteLength(`${prefix}-`, 'utf8')
  const sanitizedFileName = sanitizeTempAttachmentFileName(args?.fileName, maxSanitizedBytes)
  const fileName = sanitizedFileName ? `${prefix}-${sanitizedFileName}` : `${prefix}.png`

  if (args?.connectionId) {
    throw new SshHostNotServedError(args.connectionId)
  }

  // Why only a composer paste goes to the paste folder: its draft can bring it back after a
  // restart, while terminal, editor and phone pastes stay in OS temp, as they always have.
  let folder = getAppEnvironment().getPath('temp')
  if (args?.forNativeChatDraft === true) {
    folder = nativeChatPasteFolder()
    await fs.mkdir(folder, { recursive: true })
  }
  const tempPath = path.join(folder, fileName)
  await fs.writeFile(tempPath, buffer)
  return tempPath
}
