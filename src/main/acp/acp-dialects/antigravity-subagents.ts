import { z } from 'zod'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpSubagentUpdate } from './acp-dialect'

const invokeSubagentSchema = z.looseObject({
  Role: z.string().optional(),
  TypeName: z.string().optional(),
  Model: z.string().optional(),
  Prompt: z.string().optional()
})
const subagentOutputSchema = z.looseObject({
  conversationId: z.string().trim().min(1).optional(),
  ConversationId: z.string().trim().min(1).optional()
})
const manageSubagentsSchema = z.looseObject({
  Action: z.string().optional(),
  ConversationIds: z.array(z.string().trim().min(1)).optional()
})
const MAX_SWARM_WORKERS = 64

const swarmInputSchema = z.looseObject({
  action: z.string().optional(),
  name: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  brief: z.string().optional(),
  tasks: z.array(z.string()).optional(),
  n: z.number().int().positive().max(MAX_SWARM_WORKERS).optional()
})

function invokeSubagentLabel(
  input: z.infer<typeof invokeSubagentSchema> | undefined
): string | undefined {
  const base =
    input?.Role?.trim() || input?.TypeName?.trim() || input?.Prompt?.trim().split('\n')[0]?.trim()
  if (!base) {
    return undefined
  }
  const model = input?.Model?.trim()
  return model && model !== 'inherit' ? `${base} (${model})` : base
}

export function antigravityToolSubagents(
  update: ToolCallUpdate,
  tool: AgentJournalToolCallItem
): AcpSubagentUpdate[] {
  if (tool.name === 'invoke_subagent') {
    if (
      update.status !== 'in_progress' &&
      update.status !== 'completed' &&
      update.status !== 'failed'
    ) {
      return []
    }
    const input = invokeSubagentSchema.safeParse(tool.input).data
    const out = subagentOutputSchema.safeParse(update.rawOutput).data
    const conversationId = out?.conversationId ?? out?.ConversationId
    const label = invokeSubagentLabel(input)
    return [
      {
        id: update.toolCallId,
        state: update.status === 'failed' ? 'failed' : 'working',
        settlesWithTurn: true,
        ...(conversationId && conversationId !== update.toolCallId
          ? { aliases: [conversationId] }
          : {}),
        ...(label ? { label } : {})
      }
    ]
  }
  if (tool.name === 'manage_subagents' && update.status === 'completed') {
    const input = manageSubagentsSchema.safeParse(tool.input).data
    if (input?.Action !== 'kill' || !input.ConversationIds?.length) {
      return []
    }
    return [...new Set(input.ConversationIds)].map((id) => ({
      id,
      state: 'stopped',
      knownOnly: true
    }))
  }
  if (tool.name === 'swarm' && update.status === 'completed') {
    const input = swarmInputSchema.safeParse(tool.input).data
    if (!input?.name) {
      return []
    }
    if (input.action === 'kill') {
      return [{ id: `swarm:${input.name}`, state: 'stopped', knownOnly: true }]
    }
    if (input.action === 'add') {
      if (input.tasks?.length) {
        return input.tasks.map((task, index) => {
          const worker = `${input.name}-${index + 1}`
          const summary = task.trim().split('\n')[0]?.trim()
          return {
            id: `swarm:${worker}`,
            state: 'working',
            restart: true,
            settlesWithTurn: true,
            label: summary ? `${worker}: ${summary}` : worker
          }
        })
      }
      if (input.n && input.n > 1) {
        return Array.from({ length: input.n }, (_, index) => {
          const worker = `${input.name}-${index + 1}`
          return {
            id: `swarm:${worker}`,
            state: 'working',
            restart: true,
            settlesWithTurn: true,
            label: input.model ? `${worker} (${input.model})` : worker
          }
        })
      }
      return [
        {
          id: `swarm:${input.name}`,
          state: 'working',
          restart: true,
          settlesWithTurn: true,
          label: input.model ? `${input.name} (${input.model})` : input.name
        }
      ]
    }
  }
  return []
}
