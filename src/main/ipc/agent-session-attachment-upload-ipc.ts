import { app, ipcMain } from 'electron'
import type {
  AgentSessionAttachmentPathUploadResult,
  AgentSessionAttachmentUploadTarget
} from '../../shared/agent-session/agent-session-attachments'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  uploadExternalPaths,
  uploadExternalPathsToAgentSessionAttachments
} from './agent-session-attachment-upload'
import {
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  RUNTIME_TEMP_UPLOAD_MAX_TOTAL_BYTES,
  runtimeTempUploadTotalReason
} from '../../shared/clipboard-image'
import { saveClipboardImageBufferInRuntime } from '../window/clipboard-runtime-image-upload'
import { abortWhenRendererGone } from './renderer-lifetime-abort'

/** Handlers that copy client-local files to the paired server a chat runs on. */
export function registerAgentSessionAttachmentUploadHandlers(): void {
  ipcMain.handle(
    'fs:uploadPathsToAgentSessionAttachments',
    async (
      event,
      args: AgentSessionAttachmentUploadTarget & { paths: string[] }
    ): Promise<AgentSessionAttachmentPathUploadResult> => {
      const userDataPath = app.getPath('userData')
      // Abort on reload/close; the server sweeps abandoned part files.
      const lifetime = abortWhenRendererGone(event.sender)
      try {
        return await uploadExternalPathsToAgentSessionAttachments(
          {
            ...args,
            // The manual-disconnect check keys on the resolved id, not whatever selector came in.
            environmentId: resolveEnvironment(userDataPath, args.environmentId).id,
            userDataPath,
            signal: lifetime.signal
          },
          args.paths
        )
      } finally {
        lifetime.dispose()
      }
    }
  )
  // A terminal-backed chat's agent reads files from the server's temp folder, where pasted images go too.
  ipcMain.handle(
    'fs:uploadPathsToRuntimeTempFiles',
    async (
      event,
      args: { environmentId: string; paths: string[] }
    ): Promise<AgentSessionAttachmentPathUploadResult> => {
      const environmentId = typeof args?.environmentId === 'string' ? args.environmentId.trim() : ''
      if (!environmentId || !Array.isArray(args.paths)) {
        throw new Error('Invalid runtime upload request')
      }
      const userDataPath = app.getPath('userData')
      const lifetime = abortWhenRendererGone(event.sender)
      try {
        return await uploadExternalPaths(
          args.paths.filter((path): path is string => typeof path === 'string'),
          {
            maxBytes: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
            label: 'chat attachment limit',
            signal: lifetime.signal,
            total: {
              maxBytes: RUNTIME_TEMP_UPLOAD_MAX_TOTAL_BYTES,
              reason: runtimeTempUploadTotalReason
            }
          },
          async (file, writeBody) => {
            const parts: Buffer[] = []
            await writeBody(async (contentBase64) => {
              parts.push(Buffer.from(contentBase64, 'base64'))
            })
            lifetime.signal.throwIfAborted()
            return saveClipboardImageBufferInRuntime(
              userDataPath,
              environmentId,
              Buffer.concat(parts),
              null,
              file.name
            )
          }
        )
      } finally {
        lifetime.dispose()
      }
    }
  )
}
