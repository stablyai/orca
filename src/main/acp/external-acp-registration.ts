import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { isStructuredAgentId } from '../../shared/agent-session-provider-handle-encoding'

const literal = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0'))
export const externalAcpRegistrationSchema = z
  .object({
    agent: z.string().refine(isStructuredAgentId),
    command: literal.refine(isAbsolute),
    args: z.array(literal).max(64)
  })
  .strict()
const configurationSchema = z
  .object({
    version: z.literal(1),
    agents: z.array(externalAcpRegistrationSchema).max(32)
  })
  .strict()
export type ExternalAcpRegistration = z.infer<typeof externalAcpRegistrationSchema>

export function parseExternalAcpRegistrations(
  value: unknown,
  reserved: readonly string[]
):
  | { ok: true; registrations: ExternalAcpRegistration[] }
  | { ok: false; error: 'invalid-external-acp-registration' } {
  const parsed = configurationSchema.safeParse(value)
  if (parsed.success) {
    const seen = new Set(reserved)
    for (const entry of parsed.data.agents) {
      if (seen.has(entry.agent)) {
        return { ok: false, error: 'invalid-external-acp-registration' }
      }
      seen.add(entry.agent)
    }
    return { ok: true, registrations: parsed.data.agents }
  }
  return { ok: false, error: 'invalid-external-acp-registration' }
}
