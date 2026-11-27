import type { HandlerContext } from '../dispatch/dispatch'
import { quoteCliCommandArgument } from '../arguments/shell-command-quote'

/** The caller's exact command with `--approve <fingerprint>`, so nothing else changes on re-run. */
export function approvalRerunCommand(rawArgs: readonly string[], fingerprint: string): string {
  const kept: string[] = []
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    if (arg === '--approve') {
      index += 1
      continue
    }
    if (arg.startsWith('--approve=')) {
      continue
    }
    kept.push(arg)
  }
  return ['orca', ...kept, '--approve', fingerprint].map(quoteCliCommandArgument).join(' ')
}

export function approvalFingerprintOf(data: unknown): string | null {
  return typeof data === 'object' &&
    data !== null &&
    'approvalFingerprint' in data &&
    typeof data.approvalFingerprint === 'string'
    ? data.approvalFingerprint
    : null
}

export function nextStepsOf(data: unknown): string[] {
  return typeof data === 'object' &&
    data !== null &&
    'nextSteps' in data &&
    Array.isArray(data.nextSteps)
    ? data.nextSteps.filter((step): step is string => typeof step === 'string')
    : []
}

/** The entries of a host's error-data list whose `fields` are all strings. */
function stringRecords<Field extends string>(
  list: unknown,
  fields: readonly Field[]
): Record<Field, string>[] {
  return Array.isArray(list)
    ? list.filter(
        (entry): entry is Record<Field, string> =>
          typeof entry === 'object' &&
          entry !== null &&
          fields.every((field) => typeof entry[field] === 'string')
      )
    : []
}

export type PendingApproval = { pluginKey: string; approvalFingerprint: string }

export function pendingApprovalsOf(data: unknown): PendingApproval[] {
  const approvals =
    typeof data === 'object' && data !== null && 'approvals' in data ? data.approvals : null
  return stringRecords(approvals, ['pluginKey', 'approvalFingerprint'])
}

export type UpdateFailure = { pluginKey: string; code: string; message: string }

export function failedUpdatesOf(data: unknown): UpdateFailure[] {
  const failed = typeof data === 'object' && data !== null && 'failed' in data ? data.failed : null
  return stringRecords(failed, ['pluginKey', 'code', 'message'])
}

/** `update --all` re-runs per plugin: the same command with the key in place of --all. */
function perPluginArgs(ctx: HandlerContext, pluginKey: string): string[] {
  return (ctx.rawArgs ?? []).map((arg) => (arg === '--all' ? pluginKey : arg))
}

export function perPluginApprovalCommands(
  ctx: HandlerContext,
  approvals: PendingApproval[]
): string[] {
  return approvals.map(
    (approval) =>
      `To approve ${approval.pluginKey}, run: ${approvalRerunCommand(perPluginArgs(ctx, approval.pluginKey), approval.approvalFingerprint)}`
  )
}

/** A failed plugin's own update reports its error with the steps to fix it. */
export function perPluginFailureCommands(ctx: HandlerContext, failed: UpdateFailure[]): string[] {
  return failed.map((failure) => {
    const command = ['orca', ...perPluginArgs(ctx, failure.pluginKey)]
    return `To retry ${failure.pluginKey} and see how to fix it, run: ${command.map(quoteCliCommandArgument).join(' ')}`
  })
}
