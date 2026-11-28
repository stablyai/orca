import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { usageLimitResetsAt } from '../../../shared/agent-session/failures/agent-session-usage-limit'
import {
  readProviderRetry,
  type AgentSessionProviderRetry
} from '../../../shared/agent-session/failures/agent-session-failure'
import type { AcpAgentError } from '../transport/acp-errors'
import type {
  CompactionUpdate,
  SessionUpdate,
  ToolCallUpdate
} from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'
import { OPENCODE_CHILD_SESSION_CAPABILITY, openCodeChildUpdate } from './opencode-child-sessions'

// Normalize rawOutput.metadata to the shared stdout/exitCode fields.
const commandRawOutputSchema = lazyZodSchema(() =>
  z.looseObject({
    output: z.unknown().optional(),
    metadata: z
      .looseObject({
        exit: z.number().int().nullable().optional(),
        output: z.string().optional()
      })
      .optional()
  })
)

const promptFailureDataSchema = lazyZodSchema(() =>
  z.object({
    errorName: z.enum(['provider.quota', 'provider.rate-limit']),
    status: z.number().optional().catch(undefined),
    resetsAt: z.number().optional().catch(undefined),
    retryAfterMs: z.number().nonnegative().optional().catch(undefined)
  })
)

// OpenCode names a failed model-provider call with these; its local refusals use other names.
const providerErrorDataSchema = lazyZodSchema(() =>
  z.looseObject({
    service: z.literal('session'),
    errorName: z.enum([
      'APIError',
      'provider.error',
      'provider.rate-limit',
      'provider.quota',
      'provider.chatgpt-limit',
      'provider.free-limit',
      'provider.budget-limit',
      'provider.model-budget-limit',
      'provider.go-limit',
      'provider.transport',
      'provider.internal',
      'provider.invalid-output',
      'provider.invalid-request',
      'provider.unknown',
      'provider.timeout'
    ])
  })
)

// ACP omits HTTP status; documented billing and entitlement instructions survive in the message.
const NON_RESET_QUOTA_FAILURES = [
  /\b(?:insufficient (?:balance|account funds)|credit limit exceeded|payment required|account invoice is overdue|billing_error)\b/i,
  /\bplease add or update your payment method to continue\b/i,
  /\b(?:GLM Coding Plan|enterprise) package has expired\b/i,
  /\byour current subscription plan does not yet include access to\b/i
]

function promptFailure(error: AcpAgentError, at: number) {
  const parsed = promptFailureDataSchema.safeParse(error.data)
  if (
    !parsed.success ||
    parsed.data.status === 402 ||
    NON_RESET_QUOTA_FAILURES.some((pattern) => pattern.test(error.message))
  ) {
    // Billing refusals and other provider errors have no reset, but stay the provider's.
    return providerErrorDataSchema.safeParse(error.data).success
      ? { stopReason: 'error', providerFailure: true }
      : undefined
  }
  const { resetsAt, retryAfterMs } = parsed.data
  const reset = usageLimitResetsAt(
    resetsAt ?? (retryAfterMs === undefined ? undefined : at + retryAfterMs),
    at
  )
  return {
    stopReason: 'rate_limit',
    ...(reset === undefined ? {} : { usageLimit: { resetsAt: reset } })
  }
}

// OpenCode 2.x refuses a session/load outside the session's folder with exactly this data.
const otherFolderRefusalSchema = lazyZodSchema(() =>
  z.strictObject({ sessionId: z.string(), cwd: z.string() })
)

function sessionInOtherFolder(error: AcpAgentError, sessionId: string, cwd: string): boolean {
  const data = otherFolderRefusalSchema.safeParse(error.data)
  return (
    error.code === -32602 &&
    data.success &&
    data.data.sessionId === sessionId &&
    data.data.cwd === cwd
  )
}

function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const parsed = commandRawOutputSchema.safeParse(update.rawOutput)
  if (!parsed.success) {
    return update
  }
  const rawOutput = parsed.data
  const output =
    typeof rawOutput.output === 'string' ? rawOutput.output : rawOutput.metadata?.output
  const hasSharedOutput = ['stdout', 'stderr', 'output_for_prompt'].some(
    (key) => rawOutput[key] !== undefined
  )
  const hasSharedExitCode = rawOutput.exitCode !== undefined || rawOutput.exit_code !== undefined
  const exitCode = rawOutput.metadata?.exit ?? undefined
  if ((output === undefined || hasSharedOutput) && (exitCode === undefined || hasSharedExitCode)) {
    return update
  }
  return {
    ...update,
    rawOutput: {
      ...rawOutput,
      ...(output === undefined || hasSharedOutput ? {} : { stdout: output }),
      ...(exitCode === undefined || hasSharedExitCode ? {} : { exitCode })
    }
  }
}

// Without the client's `session.compaction` capability, OpenCode reports compaction in this marker.
const compactionMarkerSchema = lazyZodSchema(() =>
  z.object({
    status: z.enum(['started', 'completed', 'failed']),
    messageId: z.string(),
    // Only the /compact Orca sent; an auto-compaction from a queued prompt reports in the same drain.
    reason: z.literal('manual'),
    error: z.looseObject({ type: z.string(), message: z.string() }).optional().catch(undefined)
  })
)
const CANCELLED_COMPACTION_ERRORS = ['aborted', 'compaction.interrupted']

// Mirrors OpenCode's own `compaction_update`, which hides a defect's multi-line cause.
function compactionUpdate(update: SessionUpdate): CompactionUpdate | undefined {
  const marker =
    update.sessionUpdate === 'session_info_update'
      ? compactionMarkerSchema.safeParse(update._meta?.['opencode/compaction']).data
      : undefined
  if (!marker) {
    return undefined
  }
  const { status, messageId: compactionId, error } = marker
  if (status !== 'failed') {
    return { compactionId, status: status === 'started' ? 'in_progress' : status }
  }
  if (error && CANCELLED_COMPACTION_ERRORS.includes(error.type)) {
    return { compactionId, status: 'cancelled' }
  }
  const defect = error?.type === 'compaction.failed' && error.message.includes('\n')
  return {
    compactionId,
    status: 'failed',
    ...(error?.message && !defect ? { error: error.message } : {})
  }
}

const RETRY_META = 'opencode/retry'
const retrySchema = lazyZodSchema(() =>
  z.looseObject({
    attempt: z.number().optional().catch(undefined),
    error: z
      .looseObject({
        type: z.string().optional().catch(undefined),
        message: z.string().optional().catch(undefined),
        status: z.number().optional().catch(undefined)
      })
      .optional()
      .catch(undefined)
  })
)

// OpenCode reports each scheduled retry of a failed model call here, and null once its next step starts.
function providerRetry(update: SessionUpdate): AgentSessionProviderRetry | null | undefined {
  const meta = update.sessionUpdate === 'session_info_update' ? update._meta : undefined
  if (!meta || !Object.hasOwn(meta, RETRY_META)) {
    return undefined
  }
  if (meta[RETRY_META] === null) {
    return null
  }
  const { attempt, error } = retrySchema.safeParse(meta[RETRY_META]).data ?? {}
  return readProviderRetry({
    attempt,
    status: error?.status,
    cause: error?.message,
    error: error?.type === 'provider.rate-limit' ? 'rate_limit' : error?.type
  })
}

export const OPENCODE_ACP_DIALECT: AcpDialect = {
  clientCapabilities: {
    elicitation: { form: {} },
    _meta: { [OPENCODE_CHILD_SESSION_CAPABILITY]: true }
  },
  childSessionStop: {
    supported: (initialized) => initialized.agentCapabilities?.sessionCapabilities?.close != null
  },
  compactionUpdate,
  effortChangesModel: true,
  interactionModes: { default: 'build', plan: 'plan' },
  linksFileMentions: true,
  normalizeToolUpdate,
  notification: openCodeChildUpdate,
  promptFailure,
  providerRetry,
  sessionInOtherFolder
}
