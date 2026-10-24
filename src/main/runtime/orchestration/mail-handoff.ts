import { z } from 'zod'
import { readTerminalMailTarget } from '../../agent-hooks/server/terminal-mail-target'

const terminalTarget = z.unknown().transform((value, ctx) => {
  if (value === null) {
    return null
  }
  const target = readTerminalMailTarget(value)
  if (target) {
    return target
  }
  ctx.addIssue({ code: 'custom', message: 'Unproved terminal target' })
  return z.NEVER
})
const source = z.object({ sessionId: z.string(), epoch: z.string(), clientMessageId: z.string() })
const manifest = z.object({
  members: z.array(z.string()).min(1).max(50),
  body: z.string(),
  dispatchId: z.string().nullable(),
  runtimeFence: z.number(),
  context: z.string().optional()
})
const structured = z.object({
  version: z.literal(1),
  kind: z.literal('structured'),
  sessionId: z.string(),
  epoch: z.string(),
  operationId: z.string(),
  clientMessageId: z.string(),
  phase: z.enum(['reserved', 'offered']),
  authorizationId: z.string(),
  frontier: z.string(),
  authority: z.string(),
  nonAdmission: z.enum(['held', 'refused', 'expired']).optional(),
  recoverySource: z.union([source, z.string()]).optional(),
  manifest: manifest.optional()
})
const terminal = z.object({
  version: z.literal(1),
  kind: z.literal('terminal'),
  id: z.string(),
  authorizationId: z.string().optional(),
  authority: z.string(),
  phase: z.enum(['reserved', 'offered']),
  target: terminalTarget,
  recoverySource: terminalTarget.optional()
})
export type StructuredMailHandoff = z.infer<typeof structured>
export type TerminalMailHandoff = z.infer<typeof terminal>
export type AutomaticMailHandoff = StructuredMailHandoff | TerminalMailHandoff
export type MailHandoff = AutomaticMailHandoff | { version: 1; kind: 'unknown' }
export const UNKNOWN_MAIL_HANDOFF = JSON.stringify({ version: 1, kind: 'unknown' })

export function readMailHandoff(value: string | null | undefined): MailHandoff | null {
  if (value == null) {
    return null
  }
  try {
    const parsed = z.union([structured, terminal]).safeParse(JSON.parse(value))
    if (parsed.success) {
      return parsed.data
    }
  } catch {
    /* Unreadable ownership is unknown, never fresh. */
  }
  return { version: 1, kind: 'unknown' }
}

export function structuredRecoverySource(
  reference: StructuredMailHandoff
): StructuredMailHandoff | null {
  const original = reference.recoverySource
  return original
    ? { ...reference, ...(typeof original === 'string' ? { clientMessageId: original } : original) }
    : null
}
