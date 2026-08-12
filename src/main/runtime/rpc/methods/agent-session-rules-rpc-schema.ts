import { z } from 'zod'
import type { AgentSessionRulesSettings } from '../../../../shared/agent-session-rules-types'

const MAX_CLIENT_DEFAULT_RULES_BYTES = 256 * 1024
const MAX_RULE_COUNT = 256
const MAX_RULE_ID_LENGTH = 512
const MAX_RULE_LABEL_LENGTH = 4_096
const MAX_RULE_CONTENT_BYTES = 256 * 1024

const AgentSessionRule = z
  .object({
    id: z.string().min(1).max(MAX_RULE_ID_LENGTH),
    label: z.string().min(1).max(MAX_RULE_LABEL_LENGTH),
    content: z
      .string()
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= MAX_RULE_CONTENT_BYTES,
        'Agent session rule content is too large'
      ),
    enabled: z.boolean(),
    source: z.enum(['builtin', 'custom'])
  })
  .strict()

export const ClientDefaultAgentSessionRules: z.ZodType<AgentSessionRulesSettings> = z
  .object({
    enabled: z.boolean(),
    rules: z.array(AgentSessionRule).max(MAX_RULE_COUNT),
    seenBuiltinRuleIds: z
      .array(z.string().min(1).max(MAX_RULE_ID_LENGTH))
      .max(MAX_RULE_COUNT)
      .optional()
  })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_CLIENT_DEFAULT_RULES_BYTES,
    'Client default agent session rules are too large'
  )
