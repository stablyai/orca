import { z } from 'zod'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import { parseExecutionHostId } from '../../shared/execution-host'

/** The answer a create returned, as a replay reads it back. */
const RecordedTerminal = z.object({
  handle: z.string().min(1),
  ptyId: z.string().nullable().optional(),
  worktreeId: z.string().min(1),
  title: z.string().nullable(),
  tabId: z.string().optional(),
  paneKey: z.string().nullable().optional(),
  surface: z.enum(['background', 'visible']).optional(),
  warning: z.string().optional(),
  incarnationId: z.string().nullable().optional(),
  executionHostId: z.string().optional(),
  hostPlatform: z
    .enum([
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
    ])
    .optional(),
  agentSessionDisposition: z.enum(['created', 'adopted']).optional(),
  isReattach: z.literal(true).optional(),
  processId: z.number().optional()
})

type RecordedAgentSessionTerminal = z.infer<typeof RecordedTerminal>

/** Parsed before the write, so a field added to the answer later never reaches disk unreviewed. */
export function recordAgentSessionCreatedTerminal(
  terminal: RuntimeTerminalCreate
): RecordedAgentSessionTerminal | null {
  const parsed = RecordedTerminal.safeParse(terminal)
  return parsed.success ? parsed.data : null
}

export function readAgentSessionCreatedTerminal(value: unknown): RuntimeTerminalCreate | null {
  const parsed = RecordedTerminal.safeParse(value)
  if (!parsed.success) {
    return null
  }
  const { executionHostId, ...terminal } = parsed.data
  const host = parseExecutionHostId(executionHostId)
  return { ...terminal, ...(host ? { executionHostId: host.id } : {}) }
}
