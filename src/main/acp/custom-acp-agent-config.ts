import { z } from 'zod'
import { isCustomAcpAgentId } from '../../shared/custom-acp-agent'
import { isAbsolute } from 'node:path'

const literal = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0'))
const absolutePath = literal.refine(isAbsolute, 'Use an absolute host path')
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)

const customAcpAgent = z
  .object({
    id: z.string().refine(isCustomAcpAgentId),
    name: z.string().trim().min(1).max(128).optional(),
    command: literal.refine((value) => isAbsolute(value) || /^[A-Za-z0-9_.-]+$/.test(value)),
    args: z.array(literal).max(128).default([]),
    env: z.record(environmentName, literal).default({}),
    account: z.object({ variable: environmentName, directory: absolutePath }).strict()
  })
  .strict()
  .refine((agent) => !(agent.account.variable in agent.env), {
    message: 'Set the pinned account directory in account.directory, not env'
  })

export const CustomAcpAgentsConfig = z
  .object({
    apiVersion: z.literal(1),
    agents: z.array(customAcpAgent).max(32)
  })
  .strict()
  .refine(({ agents }) => new Set(agents.map(({ id }) => id)).size === agents.length, {
    message: 'Custom agent IDs must be unique'
  })

export type CustomAcpAgentConfig = z.infer<typeof customAcpAgent>
