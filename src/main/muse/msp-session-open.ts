import { mintMspCommandId, type MspClient } from './msp-client'
import type { MspSession } from './msp-protocol'

export type MspOpenedSession = {
  session: MspSession
  viewCursor: string | null
}

export async function openMspSession(
  client: MspClient,
  input: {
    workspaceRoot: string
    modelId?: string
    approvalMode?: string
    permissionProfile?: string
    resumeSessionId?: string
  }
): Promise<MspOpenedSession> {
  if (input.resumeSessionId) {
    try {
      const resumed = await client.request<{ session: MspSession; viewCursor?: string }>(
        'session/resume',
        {
          commandId: mintMspCommandId(),
          sessionId: input.resumeSessionId
        }
      )
      return { session: resumed.session, viewCursor: resumed.viewCursor ?? null }
    } catch {
      // A session the server forgot resumes as a new one.
    }
  }
  const started = await client.request<{ session: MspSession; viewCursor?: string }>(
    'session/start',
    {
      commandId: mintMspCommandId(),
      workspaceRoot: input.workspaceRoot,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
      ...(input.permissionProfile ? { permissionProfile: input.permissionProfile } : {})
    }
  )
  return { session: started.session, viewCursor: started.viewCursor ?? null }
}
