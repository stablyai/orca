import { quoteShellToken } from '../shared/ephemeral-vm-recipe-process'
import { RuntimeClientError } from './runtime-client'

export function orchestrationMutationRecoveryError(error: unknown): unknown {
  if (!(error instanceof RuntimeClientError) || !isUnknownMutationOutcomeCode(error.code)) {
    return error
  }
  const data = objectRecord(error.data)
  const requestId = data?.orchestrationRequestId
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return error
  }
  const message = [
    stripUnsafeRetryAdvice(error.message, requestId),
    'The orchestration mutation may already have taken effect; do not assume it failed.',
    `Re-issue the same command with --retry-request ${requestId} to recover idempotently. Do not retry this mutation without --retry-request.`,
    typeof data?.failedStage === 'string' ? `Failed stage: ${data.failedStage}.` : undefined,
    Array.isArray(data?.residualResources)
      ? `Residual resources: ${JSON.stringify(data.residualResources)}.`
      : undefined,
    ...residualResourceRecoveryLines(data?.residualResources)
  ]
    .filter((line): line is string => line !== undefined)
  return new RuntimeClientError(error.code, message.join('\n'), error.data)
}

/**
 * Why (#15944): the receipt names what a failed mutation left behind but not what to do with
 * it — the mutation got a recovery command (`--retry-request`), the residue got nothing, and
 * the orchestration guide ends at "inspect residualResources". Attach the reclaim command per
 * kind so a coordinator can clear the residue without reading source.
 *
 * The commands intentionally come AFTER the `--retry-request` line: a retried mutation may
 * adopt the same resources, so they are only for residue that survives the settled outcome.
 */
export function residualResourceRecoveryLines(residualResources: unknown): string[] {
  if (!Array.isArray(residualResources)) {
    return []
  }
  const lines: string[] = []
  for (const resource of residualResources) {
    const record = objectRecord(resource)
    const id = typeof record?.id === 'string' && record.id.length > 0 ? record.id : null
    if (!id) {
      continue
    }
    // Why quoting: the id is interpolated into a command meant to be copied and pasted —
    // a worktree id embeds a path, which can carry spaces or shell metacharacters.
    const quotedId = quoteShellToken(id)
    if (record?.kind === 'terminal') {
      lines.push(
        `If terminal ${id} is still residual after the outcome is settled: orca terminal close --terminal ${quotedId} --json.`
      )
    } else if (record?.kind === 'worktree') {
      const quotedSelector = quoteShellToken(`id:${id}`)
      lines.push(
        `If worktree ${id} is still residual after the outcome is settled: orca worktree rm --worktree ${quotedSelector} --force --json (verify nothing valuable was written first).`
      )
    }
  }
  return lines
}

function isUnknownMutationOutcomeCode(code: string): boolean {
  return [
    'runtime_unavailable',
    'remote_runtime_unavailable',
    'runtime_timeout',
    'invalid_runtime_response'
  ].includes(code)
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function stripUnsafeRetryAdvice(message: string, requestId: string): string {
  return message
    .replace(' Restart Orca and try again.', '')
    .replace(' Retry the command.', '')
    .replace(` Orchestration mutation request ID: ${requestId}.`, '')
}
