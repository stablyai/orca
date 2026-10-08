import { z } from 'zod'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { resolveStructuredChatLaunchOptions } from '../../../src/shared/structured-chat-launch-options'
import type { RpcClient } from '../transport/rpc-client'
import { optionalSettingsRead } from '../transport/settings-read-operations'

const chatSettings = z.object({
  nativeChatPermissionMode: z.enum(['ask', 'accept-edits', 'auto', 'bypass']).optional(),
  nativeChatSessionOptions: z
    .record(
      z.string(),
      z.object({
        model: z.string().optional(),
        valuesByModel: z
          .record(z.string(), z.record(z.string(), z.union([z.string(), z.boolean()])))
          .optional()
      })
    )
    .optional()
})

/** The phone's existing preferences belong to its paired settings host, not the execution target. */
export async function readMobileStructuredChatLaunchOptions(
  client: RpcClient,
  agent: TuiAgent
): Promise<Record<string, string> | undefined> {
  try {
    const response = await optionalSettingsRead.request(client)
    if (!response.ok) {
      return undefined
    }
    const result = optionalSettingsRead.interpret(response)
    if (!result.accepted) {
      return undefined
    }
    const parsed = chatSettings.safeParse(result.value)
    return parsed.success ? resolveStructuredChatLaunchOptions(parsed.data, agent) : undefined
  } catch {
    return undefined
  }
}
