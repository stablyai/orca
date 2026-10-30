import { z } from 'zod'
import { usageLimitResetsAt } from '../../../shared/agent-session-usage-limit'
import type { AcpAgentError } from '../acp-errors'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'

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
    return undefined
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
  effortChangesModel: true,
  normalizeToolUpdate,
  promptFailure
}
