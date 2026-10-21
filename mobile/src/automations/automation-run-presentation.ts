import type { MobileAutomationRun } from './automation-reply-schema'

const RUN_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  dispatching: 'Starting',
  dispatched: 'Dispatched',
  completed: 'Completed',
  skipped_precheck: 'Skipped · precheck',
  skipped_missed: 'Skipped · missed schedule',
  skipped_unavailable: 'Skipped · host unavailable',
  skipped_needs_interactive_auth: 'Skipped · sign-in needed',
  dispatch_failed: 'Could not start'
}
export function automationRunStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? 'Unknown result'
}
export function automationDate(timestamp: number | null | undefined, timezone?: string): string {
  if (timestamp == null) {
    return 'Not reported'
  }
  try {
    return new Date(timestamp).toLocaleString(undefined, {
      ...(timezone ? { timeZone: timezone } : {}),
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  } catch {
    return new Date(timestamp).toLocaleString()
  }
}
export function runMatchesOutcome(run: MobileAutomationRun, outcome: string): boolean {
  if (outcome === 'all') {
    return true
  }
  if (outcome === 'skipped') {
    return run.status.startsWith('skipped_')
  }
  if (outcome === 'active') {
    return ['pending', 'dispatching', 'dispatched'].includes(run.status)
  }
  return run.status === outcome
}
