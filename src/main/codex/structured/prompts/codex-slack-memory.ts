import { z } from 'zod'
import { botMemoryDate } from '../../../../shared/bot-memory-lines'
import type { SlackExecutionMemory } from '../../../native-chat/agent-session-wire/operations/slack-execution-authority'
import type { CodexAppServerServerRequest } from '../../app-server/codex-app-server-connection-types'

const Arguments = z.strictObject({
  operation: z.enum(['read', 'remember', 'forget']),
  topic: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  fact: z.string().trim().min(1).max(2_000).optional()
})

export const CODEX_SLACK_MEMORY_TOOL = {
  type: 'function' as const,
  name: 'orca_slack_memory',
  description:
    'Read or update the verified Slack requester’s memory. Read accepts an optional topic. Remember and forget require fact and accept an optional topic.',
  inputSchema: z.toJSONSchema(Arguments, { io: 'input' })
}

const Call = z.object({
  threadId: z.string(),
  turnId: z.string(),
  namespace: z.null().optional(),
  tool: z.literal(CODEX_SLACK_MEMORY_TOOL.name),
  arguments: Arguments
})

function result(success: boolean, text: string) {
  return { success, contentItems: [{ type: 'inputText' as const, text }] }
}

export async function answerCodexSlackMemory(
  session: {
    threadId: string
    activeTurnIds?: ReadonlySet<string>
    slackMemory?: SlackExecutionMemory
  },
  request: Pick<CodexAppServerServerRequest, 'method' | 'params'>
) {
  if (request.method !== 'item/tool/call') {
    return null
  }
  const call = Call.safeParse(request.params).data
  const { slackMemory: memory } = session
  if (
    !call ||
    !memory ||
    call.threadId !== session.threadId ||
    !session.activeTurnIds?.has(call.turnId)
  ) {
    return result(false, 'Scoped memory is unavailable to this tool call.')
  }
  const { operation, topic, fact } = call.arguments
  try {
    if (operation === 'read' && fact === undefined) {
      const data = topic === undefined ? await memory.read() : await memory.readTopic(topic)
      return result(true, JSON.stringify(data))
    }
    if (operation === 'read' || fact === undefined) {
      return result(false, 'Read uses an optional topic. To remember or forget, supply the fact.')
    }
    const changed =
      operation === 'remember'
        ? await memory.remember(fact, botMemoryDate(new Date()), topic)
        : await memory.forget(fact, topic)
    return result(true, JSON.stringify({ changed }))
  } catch {
    return result(false, 'Scoped memory could not be accessed.')
  }
}
