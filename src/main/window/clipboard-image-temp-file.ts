import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { getAppEnvironment } from '../../shared/app-environment'
import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'
import {
  agentSessionPastedImageName,
  sanitizeAgentSessionAttachmentName,
  type AgentSessionAttachmentClipboardTarget
} from '../../shared/agent-session/agent-session-attachments'
import { detectImageFileSignature } from '../image-file-signature'
import { nativeChatPasteFolder } from './native-chat-paste-files'
import { uploadPasteToAgentSessionAttachments } from '../ipc/agent-session-attachment-upload'
import { saveClipboardImageBufferInRuntime } from './clipboard-runtime-image-upload'
import type { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'

export type ClipboardHandlerOptions = {
  /** This machine's chat attachment store, after starting its chat host; null when it can't. */
  localChatAttachmentStore?: () => Promise<AgentSessionAttachmentStore | null>
}

export async function saveClipboardImageBufferForTarget(
  buffer: Buffer,
  args: SaveClipboardImageAsTempFileArgs | undefined,
  options: ClipboardHandlerOptions
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
  const runtimeEnvironmentId = args?.runtimeEnvironmentId?.trim()
  // A structured chat on a paired server keeps its pasted images in that server's store.
  if (runtimeEnvironmentId && args?.agentSessionAttachment) {
    return uploadPasteToAgentSessionAttachments(
      args.agentSessionAttachment,
      runtimeEnvironmentId,
      app.getPath('userData'),
      buffer
    )
  }
  // #17679: connectionId belongs to the owning runtime's SSH registry (Remote Server → SSH); only that runtime can save it.
  if (runtimeEnvironmentId) {
    return saveClipboardImageBufferInRuntime(
      app.getPath('userData'),
      runtimeEnvironmentId,
      buffer,
      args?.connectionId ?? null
    )
  }
  // Local structured-chat sends claim store-owned pastes; only unclaimed images are swept. Other composers keep the paste folder.
  if (args?.forNativeChatDraft === true && args.forStructuredChat === true && !args.connectionId) {
    const store = await options.localChatAttachmentStore?.().catch(() => null)
    if (store) {
      return store.storeFile(
        agentSessionPastedImageName(
          Date.now(),
          randomUUID(),
          detectImageFileSignature(buffer)?.extension
        ),
        buffer
      )
    }
  }
  return saveClipboardImageBufferAsTempFile(buffer, args)
}

export type SaveClipboardImageAsTempFileArgs = {
  connectionId?: string | null
  /** A phone-picked file's own name; without it the paste is named by its image bytes. */
  fileName?: string
  runtimeEnvironmentId?: string | null
  /** With `runtimeEnvironmentId`: store the image as an attachment of this structured chat. */
  agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
  /** A native-chat composer paste: kept in Orca's paste folder so its draft can bring it back. */
  forNativeChatDraft?: boolean
  /** With forNativeChatDraft, sends claim local structured-chat pastes from the chat attachment store. */
  forStructuredChat?: boolean
}

// The path is typed into terminals, so keep no character a shell would expand.
function shellInertFileName(name: string): string {
  return sanitizeAgentSessionAttachmentName(name).replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '_')
}

export async function saveClipboardImageBufferAsTempFile(
  buffer: Buffer,
  args?: SaveClipboardImageAsTempFileArgs
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)

  if (args?.connectionId) {
    throw new SshHostNotServedError(args.connectionId)
  }

  // Composer drafts must restore pastes after restart; terminal/editor/phone pastes use OS temp.
  let folder = getAppEnvironment().getPath('temp')
  if (args?.forNativeChatDraft === true) {
    folder = nativeChatPasteFolder()
    await fs.mkdir(folder, { recursive: true })
  }
  // A picked file keeps its own name, so the paste gets a folder to stay unique.
  const tempPath = args?.fileName
    ? path.join(folder, `orca-paste-${randomUUID()}`, shellInertFileName(args.fileName))
    : path.join(
        folder,
        // Phone library picks are often JPEG; agents trust the extension over the bytes.
        agentSessionPastedImageName(
          Date.now(),
          randomUUID(),
          detectImageFileSignature(buffer)?.extension
        )
      )
  if (args?.fileName) {
    await fs.mkdir(path.dirname(tempPath), { recursive: true })
  }
  await fs.writeFile(tempPath, buffer)
  return tempPath
}
