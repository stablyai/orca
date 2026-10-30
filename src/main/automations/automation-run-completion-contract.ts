import type { AutomationRun, AutomationRunOutputSnapshot } from '../../shared/automations-types'
import type { AutomationRunFailureCodeFields } from '../../shared/automation-run-failure-copy'
import type { TuiAgent } from '../../shared/tui-agent'

export type AutomationRunCompletionObservation = {
  status: 'completed' | 'dispatch_failed'
  outputSnapshot?: AutomationRunOutputSnapshot | null
  error?: string | null
} & AutomationRunFailureCodeFields

export type AutomationRunSubmission = {
  prompt: string
  agent: TuiAgent
  submitted: boolean
  onSubmit?: () => void
  current?: () => boolean
  sourceCurrent?: () => boolean
}

export type AutomationRunWatchReservation = {
  signal: AbortSignal
  bind: (run: Partial<AutomationRun>, handle: string, current?: () => boolean) => void
  assertCurrent: () => void
  submitted: () => void
  deliverySettled: () => void
  release: () => void
}

export type AutomationRunWatchEntry = {
  controller: AbortController
  observationController?: AbortController
  run: AutomationRun
  handle?: string
  targetCurrent?: () => boolean
  submission?: AutomationRunSubmission
  recovery?: boolean
  adopted: boolean
  result?: AutomationRunCompletionObservation | null
}

export type AutomationRunTerminalObserver = {
  /** Null also covers terminals that have not reattached yet. */
  resolveRunTerminal: (run: AutomationRun) => string | null
  observeCompletion: (
    handle: string,
    options: {
      signal: AbortSignal
      run?: AutomationRun
      submission?: AutomationRunSubmission
      recovery?: boolean
    }
  ) => Promise<AutomationRunCompletionObservation | null>
}

export function describeStrandedAutomationRun(run: AutomationRun): string {
  if (run.status === 'pending') {
    return 'Orca stopped before this manual run could launch.'
  }
  if (run.status === 'dispatching') {
    return 'Orca stopped before this run reported that its agent started.'
  }
  return 'Orca lost the terminal for this run before it reported completion.'
}

export function sameTerminal(a: AutomationRun, b: AutomationRun): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.sessionKind === b.sessionKind &&
    a.chatSessionId === b.chatSessionId &&
    a.terminalPaneKey === b.terminalPaneKey &&
    a.terminalPtyId === b.terminalPtyId &&
    a.terminalSessionId === b.terminalSessionId
  )
}

// Log transport tokens while keeping run history readable.
export function describeObservationError(error: unknown): string {
  console.error('[automations] run completion observation failed:', error)
  return 'Orca stopped watching this run before it reported completion.'
}
