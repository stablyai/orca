import { getOptionalStringFlag } from '../../flags'
import type { RuntimeClient } from '../../runtime-client'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'

/** Which Run `worker-list` enumerated, and why. Additive: old readers ignore it. */
export type WorkerListRunScope = { run?: string; source: 'flag' | 'bound' | 'all' }

/**
 * Unscoped `worker-list` returned every Dispatch the database has ever held. The bound Run is
 * the same Run `check` reads from the calling terminal, so it is the default and `--run`
 * overrides it. With no binding to read, listing everything stays the answer and the receipt
 * says which of the three it was.
 */
export async function resolveWorkerListRunScope(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<WorkerListRunScope> {
  const explicit = getOptionalStringFlag(flags, 'run')
  if (explicit) {
    return { run: explicit, source: 'flag' }
  }
  try {
    const terminal = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'terminal')
    const current = await client.call<{ run: { id: string } | null }>('orchestration.runCurrent', {
      from: terminal
    })
    return current.result.run ? { run: current.result.run.id, source: 'bound' } : { source: 'all' }
  } catch {
    // No live terminal, no stable pane, or a runtime that predates runCurrent: the caller asked
    // for an inventory, so answer with the whole one rather than failing the enumeration.
    return { source: 'all' }
  }
}

export function formatWorkerListScope(scope: WorkerListRunScope): string {
  if (scope.source === 'all') {
    return 'Scope: all Runs (no Run is bound to this terminal; pass --run to narrow)'
  }
  return `Scope: Run ${scope.run} (${scope.source === 'bound' ? 'bound to this terminal' : '--run'})`
}
