import type { HandlerContext } from '../dispatch'
import { quoteCliCommandArgument } from '../shell-command-quote'

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

export type PendingApproval = { pluginKey: string; approvalFingerprint: string }

export function pendingApprovalsOf(data: unknown): PendingApproval[] {
  if (typeof data !== 'object' || data === null || !('approvals' in data)) {
    return []
  }
  const { approvals } = data
  return Array.isArray(approvals)
    ? approvals.filter(
        (entry): entry is PendingApproval =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof entry.pluginKey === 'string' &&
          typeof entry.approvalFingerprint === 'string'
      )
    : []
}

/** `update --all` re-runs per plugin: the same command with the key in place of --all. */
export function perPluginApprovalCommands(
  ctx: HandlerContext,
  approvals: PendingApproval[]
): string[] {
  return approvals.map((approval) => {
    const args = (ctx.rawArgs ?? []).map((arg) => (arg === '--all' ? approval.pluginKey : arg))
    return `To approve ${approval.pluginKey}, run: ${approvalRerunCommand(args, approval.approvalFingerprint)}`
  })
}
