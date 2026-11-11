import type { SessionSearchPassArgs } from './session-search-pass'
import type { SessionSearchWork } from '../session-search-work-queue'

export async function admitSessionSearchRead(
  args: SessionSearchPassArgs,
  work: SessionSearchWork
): Promise<SessionSearchWork | undefined> {
  const { state, signal } = args
  const admission = await state.candidates.readAdmission(work.candidate)
  if (!state.queue.selectionCurrent(admission.work)) {
    return undefined
  }
  if (admission.work.work?.version !== work.version) {
    return undefined
  }
  work = admission.work.work
  const { candidate } = work
  const path = candidate.file.path
  const rootDir = admission.root
  if (rootDir === undefined) {
    await state.queue.acknowledge(work, false)
    return undefined
  }
  const observation = await state.discovery.observeForRead(
    candidate,
    rootDir,
    args.roots,
    !!work.metadata && !work.force,
    work.metadata
  )
  if (observation === null) {
    return work
  }
  if (observation.file === undefined) {
    // Observation debt owns retry/holdout; accepted facts cannot certify a refused input.
    await state.queue.acknowledge(work, false, observation.handoff)
    return undefined
  }
  if (!observation.changed) {
    return work
  }
  const refreshed = await state.candidates.update(
    [{ agent: candidate.agent, rootDir, files: [observation.file] }],
    new Set(),
    { ...args.roots, signal },
    observation.force ? new Set([path]) : new Set(),
    new Map(),
    true,
    observation.metadata ? new Set([path]) : new Set()
  )
  const admitted = await state.candidates.admitChanges(
    refreshed.receipts,
    !args.full,
    state.recovering,
    { path, delivery: observation.receipt }
  )
  state.queue.update(admitted)
  state.discovery.acceptReadCounts(admitted.scopeCounts)
  return admitted.work
}
