import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { getAppEnvironment } from '../../shared/app-environment'
import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'
import {
  sanitizeAgentSessionAttachmentName,
  type AgentSessionAttachmentClipboardTarget
} from '../../shared/agent-session-attachments'
import { nativeChatPasteFolder } from './native-chat-paste-files'

export type SaveClipboardImageAsTempFileArgs = {
  connectionId?: string | null
  /** A phone-picked file's own name; without it the paste is saved as a .png. */
  fileName?: string | null
  runtimeEnvironmentId?: string | null
  /** With `runtimeEnvironmentId`: store the image as an attachment of this structured chat. */
  agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
  /** A native-chat composer paste: kept in Orca's paste folder so its draft can bring it back. */
  forNativeChatDraft?: boolean
  /** With forNativeChatDraft, sends claim local structured-chat pastes from the chat attachment store. */
  forStructuredChat?: boolean
}

export async function saveClipboardImageBufferAsTempFile(
  buffer: Buffer,
  args?: SaveClipboardImageAsTempFileArgs
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)

  const pasteName = `orca-paste-${Date.now()}-${randomUUID()}`

  if (args?.connectionId) {
    throw new SshHostNotServedError(args.connectionId)
  }

  // Composer drafts must restore pastes after restart; terminal/editor/phone pastes use OS temp.
  let folder = getAppEnvironment().getPath('temp')
  if (args?.forNativeChatDraft === true) {
    folder = nativeChatPasteFolder()
    await fs.mkdir(folder, { recursive: true })
  }
  let tempPath = path.join(folder, `${pasteName}.png`)
  if (args?.fileName) {
    // A picked file keeps its own name, so the paste gets a folder to stay unique.
    const fileFolder = path.join(folder, pasteName)
    await fs.mkdir(fileFolder, { recursive: true })
    tempPath = path.join(fileFolder, sanitizeAgentSessionAttachmentName(args.fileName))
  }
  await fs.writeFile(tempPath, buffer)
  return tempPath
}
