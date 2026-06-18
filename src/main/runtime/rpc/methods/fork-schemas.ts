import { z } from 'zod'
import { OptionalBoolean, OptionalFiniteNumber, OptionalString } from '../schemas'
import {
  normalizePromptInteractionHistory,
  type AgentStatusPromptInteraction
} from '../../../../shared/agent-status-types'
import { normalizeAgentProviderSession } from '../../../../shared/agent-session-resume'
import {
  MAX_AGENT_SESSION_FORK_CONTEXT_CHARS,
  MAX_AGENT_SESSION_FORK_TRANSCRIPT_LINES,
  MIN_AGENT_SESSION_FORK_CONTEXT_CHARS
} from '../../../../shared/agent-session-fork'

export const ForkProviderSession = z.preprocess(
  (raw) => normalizeAgentProviderSession(raw) ?? undefined,
  z
    .object({
      key: z.enum(['session_id', 'conversation_id', 'session_path']),
      id: z.string()
    })
    .optional()
)

const ForkPromptInteraction: z.ZodType<AgentStatusPromptInteraction> = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  observedAt: z.number().finite().positive(),
  agentType: z.string().optional()
})

export const ForkPromptInteractions = z
  .preprocess(
    (raw) => normalizePromptInteractionHistory(raw),
    z.array(ForkPromptInteraction).optional()
  )
  .optional()

const ForkFallbackContextSource = z.enum(['auto', 'structured', 'transcript']).optional()
const ForkContextNumber = z.number().finite().optional()

const ForkCreateBase = z.object({
  terminal: OptionalString,
  worktree: OptionalString,
  agent: OptionalString,
  providerSession: ForkProviderSession,
  promptInteractions: ForkPromptInteractions,
  message: OptionalString,
  name: OptionalString,
  activate: OptionalBoolean,
  noCopyFiles: OptionalBoolean,
  fallbackContextSource: ForkFallbackContextSource,
  maxContextChars: ForkContextNumber,
  transcriptLineLimit: ForkContextNumber
})

function refineForkSourceShape(value: z.infer<typeof ForkCreateBase>, ctx: z.RefinementCtx): void {
  const hasTerminal = value.terminal !== undefined
  const hasProviderSource =
    value.worktree !== undefined ||
    value.agent !== undefined ||
    value.providerSession !== undefined ||
    value.promptInteractions !== undefined
  if (hasTerminal && hasProviderSource) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['terminal'],
      message: 'Pass either terminal or provider-session source fields, not both.'
    })
    return
  }
  if (!hasProviderSource) {
    return
  }
  if (!value.worktree) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['worktree'],
      message: 'Provider-session forks require worktree.'
    })
  }
  if (!value.agent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agent'],
      message: 'Provider-session forks require agent.'
    })
  }
  if (!value.providerSession) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['providerSession'],
      message: 'Provider-session forks require providerSession.'
    })
  }
}

function refineForkContextOptions(
  value: z.infer<typeof ForkCreateBase>,
  ctx: z.RefinementCtx
): void {
  if (
    value.maxContextChars !== undefined &&
    (!Number.isInteger(value.maxContextChars) ||
      value.maxContextChars < MIN_AGENT_SESSION_FORK_CONTEXT_CHARS ||
      value.maxContextChars > MAX_AGENT_SESSION_FORK_CONTEXT_CHARS)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxContextChars'],
      message: `maxContextChars must be an integer between ${MIN_AGENT_SESSION_FORK_CONTEXT_CHARS} and ${MAX_AGENT_SESSION_FORK_CONTEXT_CHARS}.`
    })
  }
  if (
    value.transcriptLineLimit !== undefined &&
    (!Number.isInteger(value.transcriptLineLimit) ||
      value.transcriptLineLimit <= 0 ||
      value.transcriptLineLimit > MAX_AGENT_SESSION_FORK_TRANSCRIPT_LINES)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['transcriptLineLimit'],
      message: `transcriptLineLimit must be an integer between 1 and ${MAX_AGENT_SESSION_FORK_TRANSCRIPT_LINES}.`
    })
  }
}

function refineForkCreate(value: z.infer<typeof ForkCreateBase>, ctx: z.RefinementCtx): void {
  refineForkSourceShape(value, ctx)
  refineForkContextOptions(value, ctx)
}

export const ForkCreate = ForkCreateBase.superRefine(refineForkCreate)

export const ForkPreflight = ForkCreateBase.pick({
  terminal: true,
  worktree: true,
  agent: true,
  providerSession: true,
  promptInteractions: true,
  message: true,
  noCopyFiles: true,
  fallbackContextSource: true,
  maxContextChars: true,
  transcriptLineLimit: true
}).superRefine(refineForkCreate)

export const ForkList = z.object({
  worktree: OptionalString,
  limit: OptionalFiniteNumber
})

export const ForkSelector = z.object({
  fork: z
    .unknown()
    .transform((value) => (typeof value === 'string' ? value : ''))
    .pipe(z.string().min(1, 'Missing fork selector'))
})

export const ForkRemove = ForkSelector.extend({
  force: OptionalBoolean,
  runHooks: OptionalBoolean
})
