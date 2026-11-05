import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'
import { agentSessionPastedImageName } from '../../shared/agent-session/agent-session-attachments'
import type { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import {
  saveClipboardImageBufferAsTempFile,
  type SaveClipboardImageAsTempFileArgs
} from './clipboard-image-temp-file'
import { uploadPasteToAgentSessionAttachments } from '../ipc/agent-session-attachment-upload'
import { saveClipboardImageBufferInRuntime } from './clipboard-runtime-image-upload'

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
      return store.storeFile(agentSessionPastedImageName(Date.now(), randomUUID()), buffer)
    }
  }
  return saveClipboardImageBufferAsTempFile(buffer, args)
}
