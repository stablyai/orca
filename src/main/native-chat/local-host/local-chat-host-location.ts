import { join } from 'node:path'
import { z } from 'zod'

export function chatHostDirectory(userData: string): string {
  return join(userData, 'local-chat-host')
}

export const chatHostEndpoint = z.object({
  protocol: z.literal(1),
  port: z.number().int().min(1).max(65535),
  token: z.string().uuid(),
  profileId: z.string()
})

export function isLocalChatMethod(method: string): boolean {
  return method.startsWith('agentSession.') || method.startsWith('agentSessionAttachment.')
}
