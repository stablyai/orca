import { z } from 'zod'
import { AI_VAULT_AGENTS, type AiVaultListResult } from '../../shared/ai-vault-types'
import { normalizeExecutionHostId } from '../../shared/execution-host'

const nodePlatformSchema = z.enum([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd'
] satisfies NodeJS.Platform[])

const executionHostIdSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeExecutionHostId(value)
  if (normalized) {
    return normalized
  }
  ctx.addIssue({ code: 'custom', message: 'Invalid execution host id' })
  return z.NEVER
})

const sessionPreviewMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool', 'unknown']),
  text: z.string(),
  timestamp: z.string().nullable()
})

const aiVaultSessionSchema = z.object({
  id: z.string(),
  executionHostId: executionHostIdSchema,
  executionHostPlatform: nodePlatformSchema.nullable().optional(),
  agent: z.enum(AI_VAULT_AGENTS),
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  branch: z.string().nullable(),
  model: z.string().nullable(),
  filePath: z.string(),
  codexHome: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  modifiedAt: z.string(),
  messageCount: z.number(),
  totalTokens: z.number(),
  previewMessages: z.array(sessionPreviewMessageSchema),
  previewMessagesTruncated: z.boolean().optional(),
  firstUserPrompt: z.string().nullable().optional(),
  lastUserPrompt: z.string().nullable().optional(),
  queuedMessageCount: z.number().default(0),
  subagentTranscriptCount: z.number().default(0),
  resumeCommand: z.string(),
  subagent: z
    .object({
      parentSessionId: z.string(),
      agentType: z.string().nullable(),
      status: z.enum(['running', 'completed', 'failed', 'stopped']).nullable()
    })
    .nullable()
    .default(null)
})

const aiVaultScanIssueSchema = z.object({
  executionHostId: executionHostIdSchema.optional(),
  agent: z.enum(AI_VAULT_AGENTS),
  kind: z.enum(['host', 'scope', 'notice']).optional(),
  path: z.string(),
  message: z.string()
})

const aiVaultListResultEnvelopeSchema = z.object({
  sessions: z.array(z.unknown()),
  issues: z.array(z.unknown()),
  scannedAt: z.string()
})

export function parseAiVaultListResult(value: unknown): AiVaultListResult {
  const envelope = aiVaultListResultEnvelopeSchema.safeParse(value)
  if (!envelope.success) {
    throw new Error(envelope.error.issues[0]?.message ?? 'unexpected result shape')
  }
  const sessions = envelope.data.sessions.flatMap((session) => {
    const parsed = aiVaultSessionSchema.safeParse(session)
    return parsed.success ? [parsed.data] : []
  })
  if (envelope.data.sessions.length > 0 && sessions.length === 0) {
    throw new Error('all supplied Agent Session History sessions were invalid')
  }
  const issues = envelope.data.issues.flatMap((issue) => {
    const parsed = aiVaultScanIssueSchema.safeParse(issue)
    return parsed.success ? [parsed.data] : []
  })
  const invalidCount =
    envelope.data.sessions.length - sessions.length + (envelope.data.issues.length - issues.length)
  if (invalidCount > 0) {
    issues.push({
      agent: 'codex',
      path: 'aiVault.listSessions',
      message: `Skipped ${invalidCount} invalid Agent Session History result ${invalidCount === 1 ? 'entry' : 'entries'}.`
    })
  }
  return { sessions, issues, scannedAt: envelope.data.scannedAt }
}
