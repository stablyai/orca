import type { WorkerEffect, WorkerSetupReceipt } from './worker-topology'

export function initializeWorkerStartResources(worktreeId: string | undefined) {
  const effects: WorkerEffect[] = []
  if (worktreeId) {
    effects.push(
      { kind: 'worktree', action: 'reused', id: worktreeId },
      { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
    )
  }
  const setupReceipt: WorkerSetupReceipt = {
    requested: 'not_applicable',
    effective: 'not_applicable',
    source: 'existing_worktree',
    hookFound: false,
    startupPolicy: 'start-immediately',
    state: 'not_applicable'
  }
  return { effects, setupReceipt }
}
