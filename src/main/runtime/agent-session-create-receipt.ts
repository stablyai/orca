import { z } from 'zod'
import { CreateAgentSessionParams } from '../../shared/rpc-contract/agent-session-params'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import { parseExecutionHostId } from '../../shared/execution-host'

const Startup = z.object({
  launchCommand: z.string(),
  env: z.record(z.string(), z.string()).optional(),
  launchConfig: z
    .object({
      agentCommand: z.string().optional(),
      agentArgs: z.string(),
      agentEnv: z.record(z.string(), z.string()),
      ompResumeFilePath: z.string().optional()
    })
    .optional(),
  startupCommandDelivery: z.enum(['fast', 'shell-ready']).optional()
})

export const AgentSessionCreateReceiptSchema = z.object({
  version: z.literal(1),
  executionOperationId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  worktreeId: z.string().min(1),
  workspacePath: z.string().min(1),
  hostId: z.string().min(1),
  connectionId: z.string().nullable(),
  terminalHandle: z.string().min(1),
  tabId: z.string().min(1),
  leafId: z.string().min(1),
  resolvedRequest: CreateAgentSessionParams,
  startup: Startup
})

export type AgentSessionCreateReceipt = z.infer<typeof AgentSessionCreateReceiptSchema>

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

export function readAgentSessionCreatedTerminal(value: unknown): RuntimeTerminalCreate | null {
  const parsed = RecordedTerminal.safeParse(value)
  if (!parsed.success) {
    return null
  }
  const { executionHostId, ...terminal } = parsed.data
  const host = parseExecutionHostId(executionHostId)
  return { ...terminal, ...(host ? { executionHostId: host.id } : {}) }
}
