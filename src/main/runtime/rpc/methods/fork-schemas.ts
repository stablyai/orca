import { z } from 'zod'
import { OptionalBoolean, OptionalFiniteNumber, OptionalString } from '../schemas'
import {
  normalizePromptInteractionHistory,
  type AgentStatusPromptInteraction
} from '../../../../shared/agent-status-types'

export const ForkProviderSession = z
  .object({
    key: z.enum(['session_id', 'conversation_id', 'session_path']),
    id: z.string()
  })
  .optional()

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

export const ForkCreate = z.object({
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

export const ForkPreflight = ForkCreate.pick({
  terminal: true,
  worktree: true,
  agent: true,
  providerSession: true,
  promptInteractions: true,
  message: true,
  noCopyFiles: true
})

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
