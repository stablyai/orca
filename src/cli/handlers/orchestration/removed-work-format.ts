import type {
  RemovedWorkEntry,
  ResetRemovedWork,
  RunRemovedWork
} from '../../../shared/orchestration-removed-work'

const count = (n: number, noun: string, plural = `${noun}s`): string =>
  `${n} ${n === 1 ? noun : plural}`
const listCommand = (runId: string): string => `orca orchestration run-show --id ${runId} --removed`

function partialNote(removed: RunRemovedWork): string {
  return removed.coverage === 'partial'
    ? `; removals before ${removed.recordedSince} were not recorded`
    : ''
}

/** The run-show line, or nothing when the Run has no removed work or the host sent no record. */
export function formatRunRemovedWorkLine(runId: string, removed?: RunRemovedWork): string {
  if (!removed || removed.tasks + removed.dispatches + removed.workers + removed.terminals === 0) {
    return ''
  }
  const active = removed.activeWorkersAtRemoval
  const running = active > 0 ? ` (${active} may still be running)` : ''
  // Only the kinds this Run actually lost, so an orphan terminal never reads as "0 tasks".
  const kinds = [
    removed.tasks > 0 ? count(removed.tasks, 'task') : '',
    removed.dispatches > 0 ? count(removed.dispatches, 'dispatch', 'dispatches') : '',
    removed.workers > 0 ? `${count(removed.workers, 'worker')}${running}` : '',
    removed.terminals > 0 ? count(removed.terminals, 'terminal') : ''
  ].filter(Boolean)
  return `\nremoved work: ${kinds.join(', ')}${partialNote(removed)}. List it: ${listCommand(runId)}`
}

function formatEntry(entry: RemovedWorkEntry): string {
  const part = (label: string, value: string | null | undefined): string =>
    value ? `${label}${value}` : ''
  if ('unreadable' in entry) {
    return `${entry.kind} ${entry.id}: record unreadable`
  }
  switch (entry.kind) {
    case 'task':
      return `task ${entry.id}${entry.title ? ` "${entry.title}"` : ''}${part(', parent ', entry.parentTaskId)}${part(', created by ', entry.createdByHandle)}`
    case 'dispatch': {
      const creator = [entry.creatorDispatchId, entry.creatorHandle].filter(Boolean).join(' / ')
      return `dispatch ${entry.id}${part(' for ', entry.taskId)}${part(', created by ', creator)}${part(', assigned to ', entry.assigneeHandle)}${part(', status ', entry.status)}`
    }
    case 'terminal':
      return entry.ownershipState === 'user_owned'
        ? `terminal ${entry.id} ${entry.terminalHandle ?? ''}: taken over by the user`
        : `terminal ${entry.id} ${entry.terminalHandle ?? ''} owned by ${entry.ownerDispatchId ?? 'unknown'}: ${entry.releaseState === 'released' ? 'released' : 'not released'}`
    case 'federated_worker':
      return `federated worker ${entry.id}${part(' on ', entry.environmentName)}${part(' in ', entry.remoteTerminalHandle)}: ${entry.dispatchStatus ?? 'unknown'} when removed${entry.activeAtRemoval ? ', may still be running' : ''}`
    case 'worker':
    case 'remote_worker': {
      const label = entry.kind === 'remote_worker' ? 'remote worker' : 'worker'
      return `${label} ${entry.id}${part(' in ', entry.terminalHandle)}${entry.worktreeId ? ` (worktree ${entry.worktreeId})` : ''}: ${entry.state ?? 'unknown'} when removed${entry.activeAtRemoval ? ', may still be running' : ''}`
    }
  }
}

/** run-show --removed: one line per removed entity, then the next-page hint. */
export function formatRemovedWorkListing(
  runId: string,
  removed?: RunRemovedWork,
  cursor?: string
): string {
  if (!removed) {
    // Also shown when a host could not read its record; run-show omits the field either way.
    return 'No record of removed work is available from this Orca host.'
  }
  const entries = removed.entries ?? []
  if (entries.length === 0) {
    return cursor
      ? `No more removed work in this Run after cursor ${cursor}.`
      : `No removed work recorded for this Run${partialNote(removed)}.`
  }
  const lines = [`Removed work in ${runId}${partialNote(removed)}`, ...entries.map(formatEntry)]
  if (removed.page?.nextCursor) {
    lines.push(`More: ${listCommand(runId)} --cursor ${removed.page.nextCursor}`)
  }
  return lines.join('\n')
}

export function formatResetResult(result: { reset: string; removed?: ResetRemovedWork }): string {
  const removed = result.removed
  if (
    !removed ||
    (removed.tasks + removed.dispatches + removed.workers === 0 && removed.runs === 0)
  ) {
    return `Reset: ${result.reset}`
  }
  const running = removed.possiblyRunning
  const runningNote =
    running > 0
      ? ` ${count(running, 'worker')} may still be running: reset stops tracking workers but does not stop them.`
      : ''
  return (
    `Reset: ${result.reset}. Removed ${count(removed.tasks, 'task')}, ` +
    `${count(removed.dispatches, 'dispatch', 'dispatches')} and ${count(removed.workers, 'worker')} ` +
    `from ${count(removed.runs, 'Run')}.${runningNote}${listHint(removed.runIds ?? [])}`
  )
}

function listHint(runIds: readonly string[]): string {
  if (runIds.length === 1) {
    return ` List what was removed: ${listCommand(runIds[0])}`
  }
  return runIds.length > 1
    ? ` Runs: ${runIds.join(', ')}. List what was removed in one: orca orchestration run-show --removed --id RUN_ID`
    : ''
}
