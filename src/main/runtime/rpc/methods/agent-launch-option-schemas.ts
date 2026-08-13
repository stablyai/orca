import { z } from 'zod'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { AgentLaunchSessionOptions, TuiAgent } from '../../../../shared/types'

const MAX_LAUNCH_OPTION_LENGTH = 512
const MAX_SESSION_OPTION_COUNT = 32

const LaunchOption = (label: string) =>
  z
    .string()
    .min(1, `Invalid ${label}`)
    .max(MAX_LAUNCH_OPTION_LENGTH, `Invalid ${label}`)
    .refine(
      (value) => value === value.trim(),
      `Invalid ${label}; surrounding whitespace is invalid`
    )

const SessionOptionKey = LaunchOption('session option key')
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, 'Invalid session option key')
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value), {
    message: 'Invalid session option key'
  })

export const AgentLaunchPreferencesSchema = z
  .object({
    model: LaunchOption('model preference').optional(),
    effort: LaunchOption('effort preference').optional(),
    mode: LaunchOption('mode preference').optional()
  })
  .strict()

export const AgentSessionOptionsSchema = z
  .record(SessionOptionKey, z.union([LaunchOption('session option value'), z.boolean()]))
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Session options must not be empty'
  })
  .refine((value) => Object.keys(value).length <= MAX_SESSION_OPTION_COUNT, {
    message: 'Too many session options'
  })

export const AgentLaunchSessionOptionsSchema: z.ZodType<AgentLaunchSessionOptions> = z
  .object({
    agent: z.custom<TuiAgent>((value) => isTuiAgent(value), 'Unknown TUI agent'),
    values: AgentSessionOptionsSchema
  })
  .strict()
