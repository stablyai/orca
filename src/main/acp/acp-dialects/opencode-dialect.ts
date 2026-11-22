import { z } from 'zod'
import { usageLimitResetsAt } from '../../../shared/agent-session/failures/agent-session-usage-limit'
import { readProviderRetry } from '../../../shared/agent-session/failures/agent-session-failure'
import type { AcpAgentError } from '../transport/acp-errors'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect, AcpDialectNotification } from './acp-dialect'
import { OPENCODE_CHILD_SESSION_CAPABILITY, openCodeChildUpdate } from './opencode-child-sessions'

// Normalize rawOutput.metadata to the shared stdout/exitCode fields.
const commandRawOutputSchema = z.looseObject({
  output: z.unknown().optional(),
  metadata: z
    .looseObject({
      exit: z.number().int().nullable().optional(),
      output: z.string().optional()
    })
    .optional()
})

const promptFailureDataSchema = z.object({
  errorName: z.enum(['provider.quota', 'provider.rate-limit']),
  status: z.number().optional().catch(undefined),
  resetsAt: z.number().optional().catch(undefined),
  retryAfterMs: z.number().nonnegative().optional().catch(undefined)
})

// OpenCode names a failed model-provider call with these; its local refusals use other names.
const providerErrorDataSchema = z.looseObject({
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
const otherFolderRefusalSchema = z.strictObject({ sessionId: z.string(), cwd: z.string() })

const providerRetrySchema = z
  .object({
    attempt: z.number().int().positive(),
    error: z.object({
      type: z.string(),
      message: z.string(),
      status: z.number().int().min(100).max(599).optional().catch(undefined)
    })
  })
  .nullable()

const compactionNotificationSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.literal('session_info_update'),
    _meta: z.object({
      'opencode/compaction': z.object({
        status: z.enum(['started', 'completed', 'failed']),
        messageId: z.string(),
        reason: z.enum(['manual', 'auto']),
        error: z.object({ type: z.string(), message: z.string().optional() }).optional()
      })
    })
  })
})

function compactionNotification(
  method: string,
  params: unknown
): AcpDialectNotification | undefined {
  if (method !== 'session/update') {
    return undefined
  }
  const parsed = compactionNotificationSchema.safeParse(params)
  if (!parsed.success) {
    return undefined
  }
  const marker = parsed.data.update._meta['opencode/compaction']
  if (marker.reason !== 'manual') {
    return undefined
  }
  const cancelled =
    marker.error?.type === 'aborted' || marker.error?.type === 'compaction.interrupted'
  return {
    disposition: 'map',
    compaction: {
      compactionId: marker.messageId,
      status:
        marker.status === 'started'
          ? 'in_progress'
          : marker.status === 'failed' && cancelled
            ? 'cancelled'
            : marker.status,
      // Match OpenCode's standard update: internal pretty-printed causes are not a person diagnostic.
      error:
        marker.error?.type === 'compaction.failed' && marker.error.message?.includes('\n')
          ? undefined
          : marker.error?.message
    }
  }
}

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

export const OPENCODE_ACP_DIALECT: AcpDialect = {
  clientCapabilities: {
    elicitation: { form: {} },
    _meta: { [OPENCODE_CHILD_SESSION_CAPABILITY]: true }
  },
  childSessionStop: {
    supported: (initialized) => initialized.agentCapabilities?.sessionCapabilities?.close != null
  },
  effortChangesModel: true,
  interactionModes: { default: 'build', plan: 'plan' },
  linksFileMentions: true,
  normalizeToolUpdate,
  notification: (method, params) =>
    openCodeChildUpdate(method, params) ?? compactionNotification(method, params),
  providerRetry: (update) => {
    if (update.sessionUpdate !== 'session_info_update') {
      return undefined
    }
    const parsed = providerRetrySchema.safeParse(update._meta?.['opencode/retry'])
    if (!parsed.success) {
      return undefined
    }
    const retry = parsed.data
    if (retry === null) {
      return null
    }
    return readProviderRetry({
      attempt: retry.attempt,
      error: retry.error.type,
      status: retry.error.status,
      cause: retry.error.message
    })
  },
  promptFailure,
  sessionInOtherFolder
}
