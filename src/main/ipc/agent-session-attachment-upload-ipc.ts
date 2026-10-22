import { app, ipcMain } from 'electron'
import type {
  AgentSessionAttachmentPathUploadResult,
  AgentSessionAttachmentUploadTarget
} from '../../shared/agent-session-attachments'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { uploadExternalPathsToAgentSessionAttachments } from './agent-session-attachment-upload'
import { abortWhenRendererGone } from './renderer-lifetime-abort'

export function registerAgentSessionAttachmentUploadHandlers(): void {
  ipcMain.handle(
    'fs:uploadPathsToAgentSessionAttachments',
    async (
      event,
      args: AgentSessionAttachmentUploadTarget & { paths: string[] }
    ): Promise<AgentSessionAttachmentPathUploadResult> => {
      const userDataPath = app.getPath('userData')
      // Why: a reload or close must stop the transfer; the server sweeps the part file it leaves.
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
}
