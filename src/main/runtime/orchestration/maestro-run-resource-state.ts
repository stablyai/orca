import type { MaestroBrowserSurfaceReceipt } from '../../../shared/maestro-browser-surface'
import type { MaestroRunResource } from '../../../shared/maestro-run-resource'
import type { MaestroTerminalLease } from '../../../shared/maestro-terminal-lease'
import type { OrchestrationNestedAgentActivity } from '../../../shared/orchestration-nested-agent-activity'
import type { DispatchContextRow, WorkerDispatchRow } from './types'
import type { TaskProgressOutcome } from './db/tasks/task-progress-outcome'

export type MaestroTerminalLiveness = 'live' | 'unverifiable' | 'exited'

export function taskResourceState(outcome: TaskProgressOutcome): MaestroRunResource['state'] {
  const states: Record<TaskProgressOutcome, MaestroRunResource['state']> = {
    pending: 'loading',
    running: 'active',
    input_required: 'input_required',
    blocked: 'blocked',
    succeeded: 'completed',
    failed: 'error',
    cancelled: 'completed'
  }
  return states[outcome]
}

export function taskResourceDetail(outcome: TaskProgressOutcome): string {
  return {
    pending: 'Waiting to start.',
    running: 'Work is active.',
    input_required: 'Waiting for coordinator input.',
    blocked: 'Work is blocked.',
    succeeded: 'Completed successfully.',
    failed: 'Completed with an error.',
    cancelled: 'Cancelled.'
  }[outcome]
}

export function dispatchResourceState(
  status: DispatchContextRow['status']
): MaestroRunResource['state'] {
  if (status === 'pending') {
    return 'loading'
  }
  if (status === 'dispatched') {
    return 'active'
  }
  if (status === 'completed') {
    return 'completed'
  }
  return 'error'
}

export function dispatchResourceDetail(status: DispatchContextRow['status']): string {
  return {
    pending: 'Waiting for dispatch.',
    dispatched: 'Worker dispatch is active.',
    completed: 'Worker dispatch completed.',
    failed: 'Worker dispatch failed.',
    circuit_broken: 'Worker dispatch stopped after repeated failures.'
  }[status]
}

export function attemptResourceState(
  state: WorkerDispatchRow['state']
): MaestroRunResource['state'] {
  if (state === 'starting') {
    return 'loading'
  }
  if (state === 'ready' || state === 'stopping') {
    return 'active'
  }
  if (state === 'start_unknown' || state === 'stop_unknown') {
    return 'unverifiable'
  }
  if (state === 'succeeded' || state === 'stopped') {
    return 'completed'
  }
  return 'error'
}

export function attemptResourceDetail(state: WorkerDispatchRow['state']): string {
  return {
    starting: 'Starting the provider execution.',
    ready: 'Provider execution is ready.',
    start_unknown: 'Provider startup could not be verified.',
    failed: 'Provider startup failed.',
    succeeded: 'Provider execution completed.',
    stopping: 'Stopping the provider execution.',
    stop_unknown: 'Provider shutdown could not be verified.',
    stopped: 'Provider execution stopped.',
    abandoned: 'Provider execution was abandoned.'
  }[state]
}

export function terminalResourceState(lease: MaestroTerminalLease): MaestroRunResource['state'] {
  if (lease.lifecycleState === 'reserved' || lease.lifecycleState === 'starting') {
    return 'loading'
  }
  if (
    ['ready', 'active', 'settled', 'retained', 'release_pending'].includes(lease.lifecycleState)
  ) {
    return 'active'
  }
  if (lease.lifecycleState === 'input_required') {
    return 'input_required'
  }
  if (lease.lifecycleState === 'outcome_unknown') {
    return 'unverifiable'
  }
  if (lease.lifecycleState === 'superseded') {
    return 'recovered'
  }
  return 'completed'
}

export function terminalResourceLiveness(
  lease: MaestroTerminalLease
): 'live' | 'unverifiable' | 'exited' {
  if (lease.cleanupReceipt) {
    return lease.cleanupReceipt.verdict
  }
  return 'unverifiable'
}

export function terminalResourceDetail(
  lease: MaestroTerminalLease,
  liveness: MaestroTerminalLiveness = terminalResourceLiveness(lease)
): string {
  if (liveness === 'unverifiable') {
    return 'Terminal liveness is unverifiable.'
  }
  if (liveness === 'exited') {
    return 'Terminal exited.'
  }
  return lease.role === 'coordinator' ? 'Coordinator terminal is live.' : 'Worker terminal is live.'
}

export function browserResourceState(
  state: MaestroBrowserSurfaceReceipt['state']
): MaestroRunResource['state'] {
  if (state === 'reserved' || state === 'creating') {
    return 'loading'
  }
  if (state === 'active' || state === 'retained' || state === 'release_pending') {
    return 'active'
  }
  if (state === 'released') {
    return 'completed'
  }
  if (state === 'outcome_unknown') {
    return 'unverifiable'
  }
  return 'error'
}

export function browserResourceDetail(browser: MaestroBrowserSurfaceReceipt): string {
  if (browser.state === 'outcome_unknown') {
    return 'Browser liveness is unverifiable.'
  }
  if (browser.state === 'unavailable') {
    return 'Browser is unavailable.'
  }
  if (browser.state === 'released') {
    return 'Browser was released.'
  }
  return `${browser.origin} · ${browser.observed_visibility}`
}

export function nestedResourceState(
  state: OrchestrationNestedAgentActivity['state']
): MaestroRunResource['state'] {
  if (state === 'starting') {
    return 'loading'
  }
  if (state === 'running' || state === 'waiting') {
    return 'active'
  }
  if (state === 'completed' || state === 'cancelled') {
    return 'completed'
  }
  return 'error'
}

export function terminalCleanupResource(
  lease: MaestroTerminalLease,
  taskTitle: string,
  liveness: MaestroTerminalLiveness = terminalResourceLiveness(lease)
): MaestroRunResource {
  const state = terminalCleanupState(lease, liveness)
  return {
    kind: 'cleanup',
    reference: `cleanup:${lease.id}`,
    parent_reference: lease.id,
    ...(lease.taskId ? { activation_reference: lease.taskId } : {}),
    title: `${taskTitle} cleanup`,
    detail: cleanupDetail(state, 'terminal'),
    state
  }
}

function terminalCleanupState(
  lease: MaestroTerminalLease,
  liveness: MaestroTerminalLiveness
): MaestroRunResource['state'] {
  if (
    liveness === 'unverifiable' ||
    lease.cleanupReceipt?.verdict === 'unverifiable' ||
    lease.lifecycleState === 'outcome_unknown'
  ) {
    return 'unverifiable'
  }
  if (lease.lifecycleState === 'released' || lease.lifecycleState === 'archived') {
    return 'completed'
  }
  if (lease.lifecycleState === 'superseded') {
    return 'recovered'
  }
  if (['settled', 'retained', 'release_pending'].includes(lease.lifecycleState)) {
    return 'active'
  }
  return 'loading'
}

export function browserCleanupResource(
  browser: MaestroBrowserSurfaceReceipt,
  title: string
): MaestroRunResource {
  const state: MaestroRunResource['state'] =
    browser.release_receipt.outcome === 'unverifiable' || browser.state === 'outcome_unknown'
      ? 'unverifiable'
      : browser.release_receipt.outcome === 'released' || browser.state === 'released'
        ? 'completed'
        : browser.retention === 'retain' || browser.release_receipt.outcome === 'retained'
          ? 'completed'
          : browser.state === 'release_pending'
            ? 'active'
            : 'loading'
  return {
    kind: 'cleanup',
    reference: `cleanup:${browser.surface_id}`,
    parent_reference: browser.surface_id,
    activation_reference: browser.task_id,
    title: `${title} browser cleanup`,
    detail: cleanupDetail(state, 'browser'),
    state
  }
}

function cleanupDetail(
  state: MaestroRunResource['state'],
  resource: 'terminal' | 'browser'
): string {
  const label = capitalizeLabel(resource)
  if (state === 'completed') {
    return `${label} cleanup completed.`
  }
  if (state === 'recovered') {
    return `${label} cleanup recovered.`
  }
  if (state === 'unverifiable') {
    return `${label} cleanup is unverifiable.`
  }
  if (state === 'active') {
    return `${label} cleanup is active.`
  }
  return `${label} cleanup waits for execution to settle.`
}

export function capitalizeLabel(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}` : 'Provider'
}
