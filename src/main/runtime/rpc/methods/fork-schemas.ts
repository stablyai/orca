import { z } from 'zod'
import { OptionalBoolean, OptionalFiniteNumber, OptionalString } from '../schemas'
import {
  normalizePromptInteractionHistory,
  type AgentStatusPromptInteraction
} from '../../../../shared/agent-status-types'
import { normalizeAgentProviderSession } from '../../../../shared/agent-session-resume'

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

const ForkCreateBase = z.object({
  terminal: OptionalString,
  worktree: OptionalString,
  agent: OptionalString,
  providerSession: ForkProviderSession,
  promptInteractions: ForkPromptInteractions,
  message: OptionalString,
  name: OptionalString,
  activate: OptionalBoolean,
  noCopyFiles: OptionalBoolean
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

export const ForkCreate = ForkCreateBase.superRefine(refineForkSourceShape)

export const ForkPreflight = ForkCreateBase.pick({
  terminal: true,
  worktree: true,
  agent: true,
  providerSession: true,
  promptInteractions: true,
  message: true,
  noCopyFiles: true
}).superRefine(refineForkSourceShape)

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
