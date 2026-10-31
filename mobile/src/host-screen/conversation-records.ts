import { z } from 'zod'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'

const historySchema = z.looseObject({
  id: z.string(),
  executionHostId: z.string().transform((value) => normalizeExecutionHostId(value)),
  sessionId: z.string(),
  agent: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  cwdAliases: z.array(z.string()).optional(),
  filePath: z.string().optional().catch(undefined),
  projectOwnerKey: z.string().nullable().optional().catch(undefined),
  updatedAt: z.string().nullable(),
  modifiedAt: z.string(),
  model: z.string().nullable().optional(),
  conversationContent: z.enum(['empty', 'present', 'unknown']).optional().catch(undefined),
  firstUserPrompt: z.string().nullable().optional(),
  previewMessagesTruncated: z.boolean().optional(),
  previewMessages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system', 'tool', 'unknown']),
        text: z.string(),
        timestamp: z.string().nullable()
      })
    )
    .optional()
    .default([]),
  subagent: z.unknown().optional(),
  structuredSession: z.object({ sessionId: z.string(), workspaceId: z.string() }).optional()
})
export type ConversationHistory = z.infer<typeof historySchema>
const historyListSchema = z.object({
  sessions: z.array(historySchema),
  issues: z.array(z.unknown()).default([]),
  fingerprint: z.string().optional(),
  unchanged: z.literal(true).optional(),
  includesStructuredSessions: z.literal(true).optional()
})
export function readConversationHistory(value: unknown) {
  return historyListSchema.parse(value)
}

const tabSchema = z.object({
  type: z.enum(['terminal', 'agent-session']),
  id: z.string(),
  title: z.string(),
  sessionId: z.string().optional(),
  agent: z.string().optional(),
  terminal: z.string().nullable().optional(),
  launchAgent: z.string().optional(),
  parentTabId: z.string().optional(),
  leafId: z.string().optional(),
  agentStatus: z
    .object({
      agentType: z.string().nullable().optional(),
      sessionId: z.string().nullable().optional()
    })
    .nullable()
    .optional()
})
export type ConversationTab = z.infer<typeof tabSchema>
export function readConversationTabs(value: unknown): ConversationTab[] {
  return z
    .object({ tabs: z.array(z.unknown()) })
    .parse(value)
    .tabs.flatMap((tab) => {
      const parsed = tabSchema.safeParse(tab)
      return parsed.success ? [parsed.data] : []
    })
}
