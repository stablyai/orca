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

  const fileName = `orca-paste-${Date.now()}-${randomUUID()}.png`

  if (args?.connectionId) {
    throw new SshHostNotServedError(args.connectionId)
  }

  // Composer drafts must restore pastes after restart; terminal/editor/phone pastes use OS temp.
  let folder = getAppEnvironment().getPath('temp')
  if (args?.forNativeChatDraft === true) {
    folder = nativeChatPasteFolder()
    await fs.mkdir(folder, { recursive: true })
  }
  const tempPath = path.join(folder, fileName)
  await fs.writeFile(tempPath, buffer)
  return tempPath
}
