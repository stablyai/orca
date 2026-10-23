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

const MAX_SANITIZED_FILE_NAME_CHARS = 120

function sanitizeTempAttachmentFileName(rawName: string | null | undefined): string | null {
  if (!rawName) {
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
  const boundedStem = stem.slice(0, Math.max(1, MAX_SANITIZED_FILE_NAME_CHARS - ext.length))
  return ext ? `${boundedStem}${ext}` : `${boundedStem}.png`
}

export async function saveClipboardImageBufferAsTempFile(
  buffer: Buffer,
  args?: SaveClipboardImageAsTempFileArgs
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)

  const sanitizedFileName = sanitizeTempAttachmentFileName(args?.fileName)
  const fileName = sanitizedFileName
    ? `orca-paste-${Date.now()}-${randomUUID()}-${sanitizedFileName}`
    : `orca-paste-${Date.now()}-${randomUUID()}.png`

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
