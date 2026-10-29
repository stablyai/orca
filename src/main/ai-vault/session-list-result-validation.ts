import { z } from 'zod'
import {
  AI_VAULT_AGENTS,
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultAgent,
  type AiVaultListResult,
  type AiVaultScanIssue,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import { aiVaultScanIssueText } from '../../shared/ai-vault-scan-issue-copy'

const aiVaultAgentSet = new Set<string>(AI_VAULT_AGENTS)

export function isAiVaultAgent(agent: string): agent is AiVaultAgent {
  return aiVaultAgentSet.has(agent)
}

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
  agent: z.string().min(1),
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  // Malformed aliases must not discard the entire session.
  cwdAliases: z
    .array(z.string().min(1).max(4096))
    .max(AI_VAULT_SCOPE_PATHS_MAX_COUNT)
    .optional()
    .catch(undefined),
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
  structuredSession: z
    .object({
      sessionId: z.string().min(1).max(512),
      workspaceId: z.string().min(1).max(512)
    })
    .optional(),
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
  agent: z.string().min(1),
  // Future issue kinds degrade to scope banners; preserve absent kinds for skipped-transcript rows (#15036).
  kind: z
    .union([z.enum(['host', 'scope', 'notice']), z.string().transform(() => 'scope' as const)])
    .optional(),
  path: z.string(),
  message: z.string(),
  // Optional localization hints; malformed ones fall back to the English message.
  messageCode: z.string().optional().catch(undefined),
  messageParams: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional()
    .catch(undefined),
  messageDetail: z.string().optional().catch(undefined)
})

const aiVaultListResultEnvelopeSchema = z
  .object({
    sessions: z.array(z.unknown()),
    issues: z.array(z.unknown()),
    scannedAt: z.string(),
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    unchanged: z.literal(true).optional()
  })
  .refine(
    (value) =>
      !value.unchanged ||
      (value.fingerprint !== undefined && value.sessions.length === 0 && value.issues.length === 0),
    'Invalid unchanged response'
  )

export function parseAiVaultListResult(value: unknown): AiVaultListResult {
  const envelope = aiVaultListResultEnvelopeSchema.safeParse(value)
  if (!envelope.success) {
    throw new Error(envelope.error.issues[0]?.message ?? 'unexpected result shape')
  }
  const sessions: AiVaultSession[] = []
  let malformedSessionCount = 0
  let wellFormedSessionCount = 0
  for (const session of envelope.data.sessions) {
    const parsed = aiVaultSessionSchema.safeParse(session)
    if (!parsed.success) {
      malformedSessionCount += 1
      continue
    }
    wellFormedSessionCount += 1
    if (!isAiVaultAgent(parsed.data.agent)) {
      continue
    }
    sessions.push({ ...parsed.data, agent: parsed.data.agent })
  }
  if (
    envelope.data.sessions.length > 0 &&
    malformedSessionCount > 0 &&
    wellFormedSessionCount === 0
  ) {
    throw new Error('all supplied Agent Session History sessions were invalid')
  }
  const issues: AiVaultScanIssue[] = []
  let malformedIssueCount = 0
  for (const issue of envelope.data.issues) {
    const parsed = aiVaultScanIssueSchema.safeParse(issue)
    if (!parsed.success) {
      malformedIssueCount += 1
      continue
    }
    if (!isAiVaultAgent(parsed.data.agent)) {
      continue
    }
    issues.push({ ...parsed.data, agent: parsed.data.agent })
  }
  const invalidCount = malformedSessionCount + malformedIssueCount
  if (invalidCount > 0) {
    issues.push({
      agent: 'codex',
      path: 'aiVault.listSessions',
      ...aiVaultScanIssueText('invalidResultsSkipped', {
        params: { count: invalidCount }
      })
    })
  }
  return {
    sessions,
    issues,
    scannedAt: envelope.data.scannedAt,
    ...(envelope.data.fingerprint ? { fingerprint: envelope.data.fingerprint } : {}),
    ...(envelope.data.unchanged ? { unchanged: true as const } : {})
  }
}
